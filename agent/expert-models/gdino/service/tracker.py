"""DeepSORT tracker: Kalman filter + Re-ID appearance matching.

Tracks detections across frames using:
    1. Kalman filter for motion prediction (position + velocity state).
    2. Re-ID feature vectors for appearance matching (via Triton gRPC).
    3. Hungarian assignment on combined motion + appearance cost.

When Triton Re-ID is not available, falls back to IoU-only matching.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
import time

import numpy as np
from scipy.optimize import linear_sum_assignment

from .config import (
    DEFAULT_APPEARANCE_WEIGHT as APPEARANCE_WEIGHT,
    DEFAULT_MAX_COST as MAX_COST_THRESHOLD,
    DEFAULT_MOTION_WEIGHT as MOTION_WEIGHT,
    FEATURE_GALLERY_SIZE,
    MAX_AGE,
    MAX_MAHALANOBIS_DIST,
    MIN_HITS,
    REID_INPUT_H,
    REID_INPUT_W,
    REID_MAX_BATCH,
    REID_MODEL_NAME,
    SHOT_TOLERANCE_S,
    TRITON_GRPC_URL,
)
from .patches import crop_patch_b64
from .schemas import FrameDetections, ShotPatch, TrackDetection

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Kalman filter (constant velocity model, state = [cx, cy, a, h, vx, vy, va, vh])
# ---------------------------------------------------------------------------


class KalmanState:
    """Per-track Kalman filter state."""

    __slots__ = ("mean", "covariance")

    # State: [cx, cy, aspect_ratio, height, vx, vy, va, vh]
    NDIM = 4

    # Motion model: constant velocity
    _F = np.eye(8)
    _F[:4, 4:] = np.eye(4)

    # Observation model: we observe [cx, cy, a, h]
    _H = np.eye(4, 8)

    # Process noise
    _std_weight_position = 1.0 / 20
    _std_weight_velocity = 1.0 / 160

    def __init__(self, bbox_xyxy: list[float]) -> None:
        cx = (bbox_xyxy[0] + bbox_xyxy[2]) / 2
        cy = (bbox_xyxy[1] + bbox_xyxy[3]) / 2
        w = bbox_xyxy[2] - bbox_xyxy[0]
        h = bbox_xyxy[3] - bbox_xyxy[1]
        a = w / max(h, 1e-6)

        self.mean = np.array([cx, cy, a, h, 0, 0, 0, 0], dtype=np.float64)
        std = [
            2 * self._std_weight_position * h,
            2 * self._std_weight_position * h,
            1e-2,
            2 * self._std_weight_position * h,
            10 * self._std_weight_velocity * h,
            10 * self._std_weight_velocity * h,
            1e-5,
            10 * self._std_weight_velocity * h,
        ]
        self.covariance = np.diag(np.square(std))

    def predict(self) -> None:
        """Advance state by one timestep."""
        h = self.mean[3]
        std_pos = [
            self._std_weight_position * h,
            self._std_weight_position * h,
            1e-2,
            self._std_weight_position * h,
        ]
        std_vel = [
            self._std_weight_velocity * h,
            self._std_weight_velocity * h,
            1e-5,
            self._std_weight_velocity * h,
        ]
        Q = np.diag(np.square(std_pos + std_vel))
        self.mean = self._F @ self.mean
        self.covariance = self._F @ self.covariance @ self._F.T + Q

    def update(self, bbox_xyxy: list[float]) -> None:
        """Incorporate a new observation."""
        cx = (bbox_xyxy[0] + bbox_xyxy[2]) / 2
        cy = (bbox_xyxy[1] + bbox_xyxy[3]) / 2
        w = bbox_xyxy[2] - bbox_xyxy[0]
        h_obs = bbox_xyxy[3] - bbox_xyxy[1]
        a = w / max(h_obs, 1e-6)
        z = np.array([cx, cy, a, h_obs])

        h = self.mean[3]
        std = [
            self._std_weight_position * h,
            self._std_weight_position * h,
            1e-1,
            self._std_weight_position * h,
        ]
        R = np.diag(np.square(std))

        S = self._H @ self.covariance @ self._H.T + R
        K = self.covariance @ self._H.T @ np.linalg.inv(S)
        y = z - self._H @ self.mean
        self.mean = self.mean + K @ y
        I_KH = np.eye(8) - K @ self._H
        self.covariance = I_KH @ self.covariance

    def mahalanobis(self, bbox_xyxy: list[float]) -> float:
        """Mahalanobis distance between predicted state and observation."""
        cx = (bbox_xyxy[0] + bbox_xyxy[2]) / 2
        cy = (bbox_xyxy[1] + bbox_xyxy[3]) / 2
        w = bbox_xyxy[2] - bbox_xyxy[0]
        h_obs = bbox_xyxy[3] - bbox_xyxy[1]
        a = w / max(h_obs, 1e-6)
        z = np.array([cx, cy, a, h_obs])

        projected_mean = self._H @ self.mean
        h = self.mean[3]
        std = [
            self._std_weight_position * h,
            self._std_weight_position * h,
            1e-1,
            self._std_weight_position * h,
        ]
        R = np.diag(np.square(std))
        S = self._H @ self.covariance @ self._H.T + R

        d = z - projected_mean
        return float(d @ np.linalg.inv(S) @ d)

    @property
    def predicted_bbox_xyxy(self) -> list[float]:
        """Convert current state to xyxy bbox."""
        cx, cy, a, h = self.mean[:4]
        w = a * h
        return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]


# ---------------------------------------------------------------------------
# Re-ID via Triton gRPC
# ---------------------------------------------------------------------------


_reid_client = None
_reid_model_ready: bool | None = None  # cached after first check

# CUDA shared memory for Re-ID zero-copy transfer
_reid_cuda_shm_pool: list | None = None
_reid_cuda_shm_lock = __import__("threading").Lock()
# Max 64 crops × 3 × 256 × 128 × 4 bytes = ~25MB per buffer
_REID_SHM_BYTES = REID_MAX_BATCH * 3 * REID_INPUT_H * REID_INPUT_W * 4


def _get_reid_client():
    """Reuse a single Triton gRPC client for Re-ID inference.

    The is_model_ready check is performed once and cached — eliminates
    a gRPC round-trip per Re-ID call.
    """
    global _reid_client, _reid_model_ready  # noqa: PLW0603
    if _reid_client is None:
        import tritonclient.grpc as grpcclient  # noqa: PLC0415
        _reid_client = grpcclient.InferenceServerClient(url=TRITON_GRPC_URL)
    if _reid_model_ready is None:
        _reid_model_ready = _reid_client.is_model_ready(REID_MODEL_NAME)
        if _reid_model_ready:
            logger.info("Re-ID model '%s' is ready on Triton", REID_MODEL_NAME)
        else:
            logger.warning("Re-ID model '%s' is NOT ready on Triton", REID_MODEL_NAME)
    if not _reid_model_ready:
        return None
    return _reid_client


def init_reid_cuda_shm(num_buffers: int = 2) -> None:
    """Pre-allocate CUDA shared memory buffers for Re-ID inference."""
    global _reid_cuda_shm_pool  # noqa: PLW0603
    if _reid_cuda_shm_pool is not None:
        return
    try:
        import tritonclient.grpc as grpcclient  # noqa: PLC0415
        import tritonclient.utils.cuda_shared_memory as cudashm  # noqa: PLC0415
        client = _get_reid_client()
        if client is None:
            _reid_cuda_shm_pool = []
            return
        pool = []
        for i in range(num_buffers):
            shm_name = f"reid_crops_{i}"
            try:
                client.unregister_cuda_shared_memory(shm_name)
            except Exception:
                pass
            shm_handle = cudashm.create_shared_memory_region(shm_name, _REID_SHM_BYTES, 0)
            client.register_cuda_shared_memory(shm_name, cudashm.get_raw_handle(shm_handle), 0, _REID_SHM_BYTES)
            pool.append((shm_name, shm_handle))
            logger.info("Registered Re-ID CUDA shared memory: %s (%d MB)", shm_name, _REID_SHM_BYTES // 1024 // 1024)
        _reid_cuda_shm_pool = pool
    except Exception:
        logger.warning("Re-ID CUDA shared memory not available, falling back to gRPC", exc_info=True)
        _reid_cuda_shm_pool = []


def _acquire_reid_shm() -> tuple | None:
    """Acquire a Re-ID CUDA shared memory buffer from the pool."""
    if not _reid_cuda_shm_pool:
        return None
    with _reid_cuda_shm_lock:
        if _reid_cuda_shm_pool:
            return _reid_cuda_shm_pool.pop()
    return None


def _release_reid_shm(item: tuple) -> None:
    """Return a Re-ID CUDA shared memory buffer to the pool."""
    with _reid_cuda_shm_lock:
        _reid_cuda_shm_pool.append(item)


def _preprocess_reid_crops(crops: list[np.ndarray]) -> np.ndarray:
    """Preprocess crops into a batched float32 tensor for Re-ID inference."""
    import cv2  # noqa: PLC0415
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    n = len(crops)
    batch_np = np.empty((n, 3, REID_INPUT_H, REID_INPUT_W), dtype=np.float32)
    for i, crop in enumerate(crops):
        img = cv2.resize(crop, (REID_INPUT_W, REID_INPUT_H), interpolation=cv2.INTER_LINEAR)
        arr = img.astype(np.float32) / 255.0
        arr = (arr - mean) / std
        batch_np[i] = arr.transpose(2, 0, 1)
    return batch_np


def _submit_reid_async(
    batch_np: np.ndarray,
    cuda_shm: tuple | None = None,
):
    """Submit async Re-ID inference via Triton. Returns a Future.

    Uses CUDA shared memory if available for zero-copy transfer,
    and async_infer with callback for non-blocking execution.
    """
    from concurrent.futures import Future  # noqa: PLC0415

    try:
        import tritonclient.grpc as grpcclient  # noqa: PLC0415
    except ImportError:
        return None

    try:
        client = _get_reid_client()
        if client is None:
            return None
    except Exception:
        return None

    inp = grpcclient.InferInput("input", batch_np.shape, "FP32")

    if cuda_shm is not None:
        try:
            import tritonclient.utils.cuda_shared_memory as cudashm_mod  # noqa: PLC0415
            shm_name, shm_handle = cuda_shm
            cudashm_mod.set_shared_memory_region(shm_handle, [batch_np])
            inp.set_shared_memory(shm_name, batch_np.nbytes)
        except Exception:
            inp.set_data_from_numpy(batch_np)
    else:
        inp.set_data_from_numpy(batch_np)

    out = grpcclient.InferRequestedOutput("fc_pred")

    fut = Future()

    def _callback(result, error):
        if error is not None:
            fut.set_exception(error if isinstance(error, Exception) else RuntimeError(str(error)))
        else:
            fut.set_result(result)

    client.async_infer(model_name=REID_MODEL_NAME, inputs=[inp], outputs=[out], callback=_callback)
    return fut


def _collect_reid_result(future) -> np.ndarray | None:
    """Collect async Re-ID result and L2-normalize features."""
    if future is None:
        return None
    try:
        result = future.result()
        features = result.as_numpy("fc_pred")
        norms = np.linalg.norm(features, axis=1, keepdims=True)
        norms = np.maximum(norms, 1e-6)
        return features / norms
    except Exception:
        logger.warning("Triton Re-ID inference failed, falling back to IoU-only")
        return None


def _extract_reid_features_triton(
    crops: list[np.ndarray],
) -> np.ndarray | None:
    """Extract Re-ID feature vectors for detection crops via Triton.

    Uses async inference + CUDA shared memory for best performance.
    Splits into sub-batches of REID_MAX_BATCH if needed.

    Args:
        crops: List of [H, W, 3] uint8 numpy arrays (person crops).

    Returns:
        [N, 256] float32 array of L2-normalized features, or None if Triton unavailable.
    """
    if not crops:
        return None

    cuda_shm = _acquire_reid_shm()
    try:
        all_features = []
        for start in range(0, len(crops), REID_MAX_BATCH):
            sub_crops = crops[start:start + REID_MAX_BATCH]
            batch_np = _preprocess_reid_crops(sub_crops)
            future = _submit_reid_async(batch_np, cuda_shm)
            features = _collect_reid_result(future)
            if features is None:
                return None
            all_features.append(features)
        return np.concatenate(all_features, axis=0) if all_features else None
    finally:
        if cuda_shm is not None:
            _release_reid_shm(cuda_shm)


# ---------------------------------------------------------------------------
# Active track
# ---------------------------------------------------------------------------


class _ActiveTrack:
    """Internal mutable track state during DeepSORT tracking."""

    __slots__ = ("track_id", "detections", "kalman", "age", "features",
                 "label", "intra_shot_patches")

    def __init__(self, track_id: int, det: TrackDetection, feature: np.ndarray | None) -> None:
        self.track_id = track_id
        self.label: str = det.label
        self.detections: list[TrackDetection] = [det]
        self.kalman = KalmanState(det.bbox_xyxy)
        self.age: int = 0
        self.features: list[np.ndarray] = []
        self.intra_shot_patches: dict[str, ShotPatch] = {}
        if feature is not None:
            self.features.append(feature)

def _feature_gallery(features: list[np.ndarray]) -> np.ndarray:
    """Return the capped feature gallery used for appearance comparisons."""
    # Use only recent features and keep matching cost bounded.
    return np.stack(features[-FEATURE_GALLERY_SIZE:])


def _batch_kalman_predict(tracks: list[_ActiveTrack]) -> None:
    """Vectorized Kalman predict across all active tracks."""
    if not tracks:
        return
    n = len(tracks)
    F = KalmanState._F  # (8, 8)
    swp = KalmanState._std_weight_position
    swv = KalmanState._std_weight_velocity

    means = np.array([trk.kalman.mean for trk in tracks])  # (N, 8)
    covs = np.array([trk.kalman.covariance for trk in tracks])  # (N, 8, 8)
    heights = means[:, 3]  # (N,)

    # Same Kalman predict step, but for all active tracks at once.
    std = np.column_stack([
        swp * heights, swp * heights, np.full(n, 1e-2), swp * heights,
        swv * heights, swv * heights, np.full(n, 1e-5), swv * heights,
    ])  # (N, 8)
    Q = np.zeros((n, 8, 8))
    idx = np.arange(8)
    Q[:, idx, idx] = std ** 2

    # Predict next state for every active track.
    new_means = means @ F.T  # (N, 8)
    new_covs = np.einsum("ij,njk,lk->nil", F, covs, F) + Q  # (N, 8, 8)

    # Write back to individual track objects
    for i, trk in enumerate(tracks):
        trk.kalman.mean = new_means[i]
        trk.kalman.covariance = new_covs[i]


def _iou_matrix(boxes_a: np.ndarray, boxes_b: np.ndarray) -> np.ndarray:
    """Vectorized IoU: (N, 4) x (M, 4) -> (N, M) matrix."""
    x1 = np.maximum(boxes_a[:, 0:1], boxes_b[:, 0])  # (N, M)
    y1 = np.maximum(boxes_a[:, 1:2], boxes_b[:, 1])
    x2 = np.minimum(boxes_a[:, 2:3], boxes_b[:, 2])
    y2 = np.minimum(boxes_a[:, 3:4], boxes_b[:, 3])
    inter = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    area_a = (boxes_a[:, 2] - boxes_a[:, 0]) * (boxes_a[:, 3] - boxes_a[:, 1])
    area_b = (boxes_b[:, 2] - boxes_b[:, 0]) * (boxes_b[:, 3] - boxes_b[:, 1])
    union = area_a[:, np.newaxis] + area_b[np.newaxis, :] - inter
    return np.where(union > 0, inter / union, 0.0)


def _batch_mahalanobis(tracks: list, det_obs: np.ndarray) -> np.ndarray:
    """Fully vectorized Mahalanobis distance: N_tracks x M_dets.

    det_obs: (M, 4) array of [cx, cy, aspect_ratio, height] for each detection.
    Returns (N, M) distance matrix.
    """
    n_tracks = len(tracks)
    n_dets = det_obs.shape[0]
    H = KalmanState._H  # (4, 8) shared across all tracks
    swp = KalmanState._std_weight_position

    # Compare in observation space: [cx, cy, aspect_ratio, height].
    means = np.array([trk.kalman.mean for trk in tracks])  # (N, 8)
    covs = np.array([trk.kalman.covariance for trk in tracks])  # (N, 8, 8)

    projected_means = means @ H.T  # (N, 4)
    heights = means[:, 3]  # (N,)

    # Same measurement noise as update(), batched.
    std = np.column_stack([
        swp * heights, swp * heights,
        np.full(n_tracks, 1e-1), swp * heights,
    ])  # (N, 4)
    R = np.zeros((n_tracks, 4, 4))
    idx = np.arange(4)
    R[:, idx, idx] = std ** 2

    # S = H @ cov @ H.T + R, all batched: (N, 4, 4)
    HcovHT = np.einsum("ij,njk,lk->nil", H, covs, H)  # (N, 4, 4)
    S = HcovHT + R  # (N, 4, 4)
    S_inv = np.linalg.inv(S)  # (N, 4, 4)

    # diff[i, j] = det_obs[j] - projected_means[i], shape (N, M, 4)
    diff = det_obs[np.newaxis, :, :] - projected_means[:, np.newaxis, :]

    # d[i, j] = motion distance between track i and detection j.
    tmp = np.einsum("nmk,nkl->nml", diff, S_inv)  # (N, M, 4)
    dists = np.einsum("nmk,nmk->nm", tmp, diff)  # (N, M)

    return dists


def _batch_appearance_distance(tracks: list, det_features: list) -> np.ndarray:
    """Batch appearance distance: N_tracks x M_dets.

    Returns (N, M) cosine distance matrix. 1.0 if no features available.
    """
    n_tracks = len(tracks)
    n_dets = len(det_features)
    dists = np.ones((n_tracks, n_dets))

    feat_idxs = [j for j in range(n_dets) if det_features[j] is not None]
    if not feat_idxs:
        return dists

    det_feat_matrix = np.stack([det_features[j] for j in feat_idxs])  # (K, 256)

    for i, trk in enumerate(tracks):
        if not trk.features:
            continue
        gallery = _feature_gallery(trk.features)  # (G, 256)
        # Match against the best recent feature, not only the latest one.
        max_sim = (gallery @ det_feat_matrix.T).max(axis=0)  # (K,)
        dists[i, feat_idxs] = 1.0 - max_sim

    return dists



# ---------------------------------------------------------------------------
# Crop extraction helper
# ---------------------------------------------------------------------------


def _extract_crops_from_image(
    img: np.ndarray, dets: list[TrackDetection],
) -> list[np.ndarray]:
    """Extract person crops from a frame image for Re-ID."""
    crops: list[np.ndarray] = []
    for d in dets:
        x1 = max(0, int(d.bbox_xyxy[0]))
        y1 = max(0, int(d.bbox_xyxy[1]))
        x2 = min(img.shape[1], int(d.bbox_xyxy[2]))
        y2 = min(img.shape[0], int(d.bbox_xyxy[3]))
        if x2 > x1 and y2 > y1:
            crops.append(img[y1:y2, x1:x2])
        else:
            crops.append(np.zeros((REID_INPUT_H, REID_INPUT_W, 3), dtype=np.uint8))
    return crops


# ---------------------------------------------------------------------------
# Matching logic
# ---------------------------------------------------------------------------


def _match_frame(
    active: list[_ActiveTrack],
    dets: list[TrackDetection],
    det_features: list[np.ndarray | None],
    appearance_weight: float,
    motion_weight: float,
    max_cost: float,
) -> tuple[set[int], set[int]]:
    """Match detections to active tracks for a single frame.

    Returns (matched_track_indices, matched_det_indices).
    """
    matched_track_idx: set[int] = set()
    matched_det_idx: set[int] = set()

    if not active or not dets:
        return matched_track_idx, matched_det_idx

    n_tracks = len(active)
    n_dets = len(dets)

    # Build detection observation matrix for Mahalanobis: (M, 4) = [cx, cy, a, h]
    det_bboxes = np.array([d.bbox_xyxy for d in dets])  # (M, 4) xyxy
    det_cx = (det_bboxes[:, 0] + det_bboxes[:, 2]) / 2
    det_cy = (det_bboxes[:, 1] + det_bboxes[:, 3]) / 2
    det_w = det_bboxes[:, 2] - det_bboxes[:, 0]
    det_h = det_bboxes[:, 3] - det_bboxes[:, 1]
    det_a = det_w / np.maximum(det_h, 1e-6)
    det_obs = np.stack([det_cx, det_cy, det_a, det_h], axis=1)  # (M, 4)

    # Predicted track bboxes
    trk_bboxes = np.array([trk.kalman.predicted_bbox_xyxy for trk in active])  # (N, 4)

    # Build motion and appearance costs.
    maha_dists = _batch_mahalanobis(active, det_obs)           # (N, M)
    iou_mat = _iou_matrix(trk_bboxes, det_bboxes)             # (N, M)
    app_dists = _batch_appearance_distance(active, det_features)  # (N, M)

    # Gate by label: only allow matching detections with same label as track
    trk_labels = np.array([trk.label for trk in active])  # (N,)
    det_labels = np.array([d.label for d in dets])  # (M,)
    label_match = trk_labels[:, np.newaxis] == det_labels[np.newaxis, :]  # (N, M)

    # Gate by Mahalanobis distance
    valid = (maha_dists <= MAX_MAHALANOBIS_DIST) & label_match

    # Check which pairs have Re-ID features on both sides
    has_det_feat = np.array([f is not None for f in det_features])  # (M,)
    has_trk_feat = np.array([bool(trk.features) for trk in active])  # (N,)
    both_feat = has_trk_feat[:, np.newaxis] & has_det_feat[np.newaxis, :]  # (N, M)

    # Re-ID if both sides have features; else IoU-only fallback.
    cost = np.full((n_tracks, n_dets), 1e5)
    mask_full = valid & both_feat
    cost[mask_full] = (appearance_weight * app_dists[mask_full] +
                       motion_weight * (1.0 - iou_mat[mask_full]))
    mask_fallback = valid & ~both_feat
    cost[mask_fallback] = 1.0 - iou_mat[mask_fallback]

    # Best one-to-one assignment for this frame.
    row_idx, col_idx = linear_sum_assignment(cost)
    for r, c in zip(row_idx, col_idx):
        if cost[r, c] < max_cost:
            active[r].detections.append(dets[c])
            active[r].kalman.update(dets[c].bbox_xyxy)
            active[r].age = 0
            if det_features[c] is not None:
                active[r].features.append(det_features[c])
            matched_track_idx.add(r)
            matched_det_idx.add(c)

    return matched_track_idx, matched_det_idx


# ---------------------------------------------------------------------------
# Chunk state
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _PreparedChunk:
    """Prepared tracker chunk with optional in-flight Re-ID work."""

    per_frame_dets: list[list[TrackDetection]]
    crop_frame_map: list[tuple[int, int]]
    all_crops: list[np.ndarray]
    reid_future: object | None
    reid_shm: tuple | None
    frame_images: list[np.ndarray] | None


# ---------------------------------------------------------------------------
# IncrementalTracker
# ---------------------------------------------------------------------------


class IncrementalTracker:
    """Incremental DeepSORT tracker that processes frames as they arrive.

    Public flow:
        1. push_chunk(...)
        2. push_chunk(...)
        3. ...
        4. flush()
        5. finalize()
    """

    def __init__(
        self,
        *,
        max_age: int = MAX_AGE,
        appearance_weight: float = APPEARANCE_WEIGHT,
        motion_weight: float = MOTION_WEIGHT,
        max_cost: float = MAX_COST_THRESHOLD,
        shot_patch_requests: list[tuple[str, float, float, set[str] | None]] | None = None,
    ) -> None:
        self._next_id = 0
        self._active: list[_ActiveTrack] = []
        self._finished: list[_ActiveTrack] = []
        self._max_age = max_age
        self._appearance_weight = appearance_weight
        self._motion_weight = motion_weight
        self._max_cost = max_cost
        self._timings: dict[str, float] = {}
        self._pending_chunk: _PreparedChunk | None = None
        # shot_key → (start, end, allowed_labels) for intra-shot patches
        self._shot_intervals: dict[str, tuple[float, float, set[str] | None]] = {}
        if shot_patch_requests:
            for key, start, end, allowed_labels in shot_patch_requests:
                self._shot_intervals[key] = (start, end, allowed_labels)

    def push_chunk(
        self,
        frame_detections: list[FrameDetections],
        frame_images: list[np.ndarray] | None = None,
    ) -> None:
        """Push one chunk while keeping one later chunk of Re-ID in flight."""
        if self._pending_chunk is not None:
            self._consume_chunk(self._pending_chunk)
            self._pending_chunk = None

        if frame_detections:
            self._pending_chunk = self._prepare_chunk(frame_detections, frame_images)

    def flush(self) -> None:
        """Finish the last pending chunk, if any."""
        if self._pending_chunk is None:
            return
        self._consume_chunk(self._pending_chunk)
        self._pending_chunk = None

    def _prepare_chunk(
        self,
        frame_detections: list[FrameDetections],
        frame_images: list[np.ndarray] | None = None,
    ) -> _PreparedChunk:
        """Flatten detections, crop images, and start Re-ID work."""
        if not frame_detections:
            return _PreparedChunk([], [], [], None, None, None)

        _t0 = time.monotonic()
        per_frame_dets: list[list[TrackDetection]] = []
        all_crops: list[np.ndarray] = []
        # flat crop idx -> (frame idx, det idx)
        crop_frame_map: list[tuple[int, int]] = []

        for fi, frame in enumerate(frame_detections):
            dets = [
                TrackDetection(
                    frame_idx=frame.frame_idx,
                    timestamp=frame.timestamp,
                    bbox_xyxy=d.bbox_xyxy,
                    confidence=d.confidence,
                    label=d.label,
                )
                for d in frame.detections
            ]
            per_frame_dets.append(dets)

            if dets and frame_images is not None and fi < len(frame_images):
                img = frame_images[fi]
                crops = _extract_crops_from_image(img, dets)
                for di, crop in enumerate(crops):
                    all_crops.append(crop)
                    crop_frame_map.append((fi, di))

        self._timings["crop_extract"] = self._timings.get("crop_extract", 0) + (time.monotonic() - _t0)

        # Small batch: async Re-ID now. Large batch: chunk later.
        _t1 = time.monotonic()
        reid_future = None
        reid_shm = None
        if all_crops:
            if len(all_crops) <= REID_MAX_BATCH:
                reid_shm = _acquire_reid_shm()
                batch_np = _preprocess_reid_crops(all_crops)
                reid_future = _submit_reid_async(batch_np, reid_shm)
            # Larger batches are chunked later in _consume_chunk().
        self._timings["reid_submit"] = self._timings.get("reid_submit", 0) + (time.monotonic() - _t1)

        return _PreparedChunk(
            per_frame_dets=per_frame_dets,
            crop_frame_map=crop_frame_map,
            all_crops=all_crops,
            reid_future=reid_future,
            reid_shm=reid_shm,
            frame_images=frame_images,
        )

    def _consume_chunk(self, chunk: _PreparedChunk) -> None:
        """Collect Re-ID output, then predict/match/update per frame."""
        per_frame_dets = chunk.per_frame_dets
        crop_frame_map = chunk.crop_frame_map
        all_crops = chunk.all_crops
        reid_future = chunk.reid_future
        reid_shm = chunk.reid_shm
        frame_images = chunk.frame_images

        if not per_frame_dets:
            return

        # 1) Collect Re-ID output.
        _t1 = time.monotonic()
        all_features: np.ndarray | None = None
        if all_crops:
            if reid_future is not None:
                all_features = _collect_reid_result(reid_future)
            else:
                # Large batch fallback: synchronous chunked inference
                all_features = _extract_reid_features_triton(all_crops)
        if reid_shm is not None:
            _release_reid_shm(reid_shm)
        self._timings["reid_infer"] = self._timings.get("reid_infer", 0) + (time.monotonic() - _t1)

        # 2) Rebuild per-frame feature lists.
        per_frame_features: list[list[np.ndarray | None]] = []
        for fi, dets in enumerate(per_frame_dets):
            per_frame_features.append([None] * len(dets))

        if all_features is not None:
            for crop_idx, (fi, di) in enumerate(crop_frame_map):
                per_frame_features[fi][di] = all_features[crop_idx]

        # 3) Per frame: predict -> match -> age/spawn -> retire.
        for fi, (dets, det_features) in enumerate(zip(per_frame_dets, per_frame_features)):
            _t2 = time.monotonic()
            _batch_kalman_predict(self._active)
            self._timings["kalman_predict"] = self._timings.get("kalman_predict", 0) + (time.monotonic() - _t2)

            if not dets and not self._active:
                continue

            _t3 = time.monotonic()
            matched_track_idx, matched_det_idx = _match_frame(
                self._active, dets, det_features,
                self._appearance_weight, self._motion_weight, self._max_cost,
            )
            self._timings["match_frame"] = self._timings.get("match_frame", 0) + (time.monotonic() - _t3)

            for i, trk in enumerate(self._active):
                if i not in matched_track_idx:
                    trk.age += 1

            # Update patches only for accepted track detections.
            img = frame_images[fi] if frame_images is not None and fi < len(frame_images) else None
            if img is not None:
                for r in matched_track_idx:
                    trk = self._active[r]
                    last_det = trk.detections[-1]
                    # Intra-shot patches: best confidence within each shot interval
                    self._update_intra_shot_patches(trk, last_det, img)

            for j, det in enumerate(dets):
                if j not in matched_det_idx:
                    new_trk = _ActiveTrack(self._next_id, det, det_features[j])
                    if img is not None:
                        self._update_intra_shot_patches(new_trk, det, img)
                    self._active.append(new_trk)
                    self._next_id += 1

            still_active: list[_ActiveTrack] = []
            for trk in self._active:
                if trk.age > self._max_age:
                    self._finished.append(trk)
                else:
                    still_active.append(trk)
            self._active = still_active

    def _update_intra_shot_patches(
        self, trk: _ActiveTrack, det: TrackDetection, img: np.ndarray,
    ) -> None:
        """Update intra-shot patches for a track if the detection falls within a shot interval."""
        if not self._shot_intervals:
            return
        tol = SHOT_TOLERANCE_S
        for shot_key, (shot_start, shot_end, allowed_labels) in self._shot_intervals.items():
            if allowed_labels is not None and det.label not in allowed_labels:
                continue
            if shot_start - tol <= det.timestamp <= shot_end + tol:
                current_patch = trk.intra_shot_patches.get(shot_key)
                if current_patch is None or det.confidence >= current_patch.confidence:
                    patch_b64 = crop_patch_b64(img, det.bbox_xyxy)
                    if patch_b64:
                        trk.intra_shot_patches[shot_key] = ShotPatch(
                            label=det.label,
                            patch_b64=patch_b64,
                            timestamp=det.timestamp,
                            bbox_xyxy=det.bbox_xyxy,
                            confidence=det.confidence,
                        )

    def finalize(
        self,
        min_track_length: int = MIN_HITS,
        merge_max_gap_seconds: float = 0.0,
        merge_cosine_threshold: float = 0.0,
    ) -> list[_ActiveTrack]:
        """Finalize tracking: retire all active tracks and return internal results."""
        self.flush()
        self._finished.extend(self._active)
        self._active = []

        tracks = [t for t in self._finished if len(t.detections) >= min_track_length]

        if merge_max_gap_seconds > 0 and merge_cosine_threshold > 0:
            tracks = _merge_fragmented_tracks(tracks, merge_max_gap_seconds, merge_cosine_threshold)

        return tracks

def _merge_fragmented_tracks(
    tracks: list[_ActiveTrack],
    max_gap_seconds: float,
    cosine_threshold: float,
) -> list[_ActiveTrack]:
    """Merge fragmented tracks that likely belong to the same identity.

    Compares Re-ID feature galleries between track pairs. If track A ends
    before track B starts (within max_gap_seconds) and their appearance
    is similar enough (cosine distance < cosine_threshold), B is merged into A.
    """
    if len(tracks) < 2:
        return tracks

    # Sort by start time
    tracks.sort(key=lambda t: t.detections[0].timestamp)

    # Post-pass merge of short gaps.
    merged_into: dict[int, int] = {}  # track index -> merged-into index

    for i in range(len(tracks)):
        if i in merged_into:
            continue
        if not tracks[i].features:
            continue

        a_end = tracks[i].detections[-1].timestamp
        a_gallery = _feature_gallery(tracks[i].features)

        for j in range(i + 1, len(tracks)):
            if j in merged_into:
                continue
            if not tracks[j].features:
                continue

            b_start = tracks[j].detections[0].timestamp
            gap = b_start - a_end

            # B must start after A ends, within the allowed gap
            if gap < 0 or gap > max_gap_seconds:
                continue

            b_gallery = _feature_gallery(tracks[j].features)

            # Max cosine similarity between any pair from the two galleries
            similarity = (a_gallery @ b_gallery.T).max()
            cosine_dist = 1.0 - float(similarity)

            if cosine_dist < cosine_threshold:
                # Merge B into A
                tracks[i].detections.extend(tracks[j].detections)
                tracks[i].features.extend(tracks[j].features)
                for shot_key, shot_patch in tracks[j].intra_shot_patches.items():
                    current_patch = tracks[i].intra_shot_patches.get(shot_key)
                    if current_patch is None or shot_patch.confidence >= current_patch.confidence:
                        tracks[i].intra_shot_patches[shot_key] = shot_patch
                # Update A's end time for chained merges
                a_end = tracks[i].detections[-1].timestamp
                if tracks[i].features:
                    a_gallery = _feature_gallery(tracks[i].features)
                merged_into[j] = i
                logger.info(
                    "Merged track %d into %d (gap=%.1fs, cosine_dist=%.3f)",
                    tracks[j].track_id, tracks[i].track_id, gap, cosine_dist,
                )

    return [t for idx, t in enumerate(tracks) if idx not in merged_into]
