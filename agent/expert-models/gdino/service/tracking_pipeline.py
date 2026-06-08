"""Tracking orchestration for the Triton-backed GDINO service."""

from __future__ import annotations

import logging
import subprocess
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
from fastapi import HTTPException

from .config import (
    DEFAULT_APPEARANCE_WEIGHT,
    DEFAULT_MAX_AGE_SECONDS,
    DEFAULT_MAX_COST,
    DEFAULT_MERGE_COSINE_THRESHOLD,
    DEFAULT_MERGE_MAX_GAP_SECONDS,
    DEFAULT_MIN_TRACK_SECONDS,
    DEFAULT_MOTION_WEIGHT,
    FFMPEG_TIMEOUT_SECONDS,
    GDINO_BATCH_SIZE,
    MAX_FRAMES_PER_REQUEST,
    PREDICTED_BBOX_EXPANSION,
    TRACKER_BATCH_MULTIPLIER,
)
from .frame_io import build_http_input_args, build_scale_filter, compute_scaled_dimensions, probe_video_metadata
from .patches import crop_patch_b64
from .schemas import (
    Detection,
    ExtractPatchCandidatesRequest,
    ExtractPatchCandidatesResponse,
    FrameDetections,
    PatchCandidate,
    ProfilingData,
    ReferencePatch,
    ReferencePatchRequest,
)
from .tracker import IncrementalTracker
from .triton_backend import (
    acquire_cuda_shm,
    collect_batch_detections,
    preprocess_gdino_image,
    release_cuda_shm,
    submit_async_infer_batch,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _VideoSegment:
    """Resolved video segment and decode geometry for one request."""

    width: int
    height: int
    fps: float
    source_fps: float
    start_time: float
    end_time: float
    seek_time: float | None
    duration_limit: float | None

    @property
    def duration(self) -> float:
        return self.end_time - self.start_time

    @property
    def frame_interval(self) -> float:
        return 1.0 / self.fps

    @property
    def source_frame_duration(self) -> float:
        return 1.0 / self.source_fps

    @property
    def frame_size(self) -> int:
        return self.width * self.height * 3


@dataclass
class _PipelineStats:
    """Mutable timing counters for one patch-candidate extraction request."""

    ffmpeg_start_s: float
    gpu_wait_s: float = 0.0
    gpu_submit_s: float = 0.0
    io_wait_s: float = 0.0
    tracker_s: float = 0.0
    grpc_calls: int = 0


@dataclass(frozen=True)
class _DetectedFrame:
    """One decoded frame with detections already attached."""

    frame_idx: int
    timestamp: float
    frame: np.ndarray
    detections: list[Detection]


@dataclass(frozen=True)
class _DecodedBatch:
    """One decoded batch plus detector inputs."""

    frame_idx_start: int
    frames: list[np.ndarray]
    detector_inputs: list[np.ndarray]

    @property
    def num_frames(self) -> int:
        return len(self.frames)


@dataclass(frozen=True)
class _DetectedBatch:
    """One detection batch emitted by the decode/detect stream."""

    frames: list[_DetectedFrame]

    @property
    def num_frames(self) -> int:
        return len(self.frames)


@dataclass
class _TrackerChunkBuffer:
    """Accumulate detected frames until the tracker chunk is ready.

    Mutable by design: this is the handoff buffer between the detected-batch
    stream and the stateful tracker.
    """

    max_frames: int
    frame_detections: list[FrameDetections] = field(default_factory=list)
    frame_images: list[np.ndarray] = field(default_factory=list)

    def add_batch(self, batch: _DetectedBatch) -> None:
        for detected_frame in batch.frames:
            self.frame_detections.append(
                FrameDetections(
                    frame_idx=detected_frame.frame_idx,
                    timestamp=detected_frame.timestamp,
                    detections=detected_frame.detections,
                )
            )
            self.frame_images.append(detected_frame.frame)

    def ready(self) -> bool:
        return len(self.frame_detections) >= self.max_frames

    def empty(self) -> bool:
        return not self.frame_detections

    def take(self) -> tuple[list[FrameDetections], list[np.ndarray]]:
        frame_detections = self.frame_detections
        frame_images = self.frame_images
        self.frame_detections = []
        self.frame_images = []
        return frame_detections, frame_images


@dataclass(frozen=True)
class _TrackerRuntime:
    """Tracker instance plus finalize settings derived from the request."""

    tracker: IncrementalTracker
    min_track_frames: int
    merge_gap_seconds: float
    merge_cosine_threshold: float


def _resolve_video_segment(req: ExtractPatchCandidatesRequest) -> _VideoSegment:
    """Validate the requested time window and resolve scaled decode dimensions."""
    if req.fps <= 0:
        raise HTTPException(status_code=400, detail=f"fps must be positive, got {req.fps}")

    if req.video_metadata is not None:
        raw_w = req.video_metadata.raw_width
        raw_h = req.video_metadata.raw_height
        video_duration = req.video_metadata.video_duration
        source_fps = req.video_metadata.source_fps
    else:
        # Probe once only when upstream metadata was not provided.
        raw_w, raw_h, video_duration, source_fps = probe_video_metadata(req.video_path)
    video_w, video_h = compute_scaled_dimensions(raw_w, raw_h)

    seg_start = req.start_time if req.start_time is not None else 0.0
    seg_end = req.end_time if req.end_time is not None else video_duration
    seg_duration = seg_end - seg_start
    if seg_duration <= 0:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid time range: start_time={seg_start}s >= end_time={seg_end}s",
        )

    estimated_frames = int(seg_duration * req.fps)
    if estimated_frames > MAX_FRAMES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Too many frames: {estimated_frames} exceeds limit of {MAX_FRAMES_PER_REQUEST}. "
                f"Reduce fps (currently {req.fps}) or use start_time/end_time to process a segment."
            ),
        )

    return _VideoSegment(
        width=video_w,
        height=video_h,
        fps=req.fps,
        source_fps=source_fps,
        start_time=seg_start,
        end_time=seg_end,
        seek_time=req.start_time,
        duration_limit=seg_duration if req.end_time is not None else None,
    )


def _build_ffmpeg_cmd(video_path: str, segment: _VideoSegment) -> list[str]:
    """Build the ffmpeg command used to decode the requested segment."""
    scale_filter = build_scale_filter()
    seek_args = ["-ss", str(segment.seek_time)] if segment.seek_time is not None else []
    duration_args = ["-t", str(segment.duration_limit)] if segment.duration_limit is not None else []
    return [
        "ffmpeg",
        "-v",
        "error",
        *build_http_input_args(video_path),
        *seek_args,
        "-i",
        video_path,
        *duration_args,
        "-vf",
        f"fps={segment.fps},{scale_filter}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]


def _read_and_preprocess_frame(pipe, segment: _VideoSegment) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Read one RGB frame from ffmpeg and preprocess it for GDINO."""
    raw = pipe.read(segment.frame_size)
    if len(raw) < segment.frame_size:
        return None, None

    frame = np.frombuffer(raw, dtype=np.uint8).reshape(segment.height, segment.width, 3).copy()
    return frame, preprocess_gdino_image(frame)


def _read_batch(
    pipe,
    segment: _VideoSegment,
    batch_size: int,
    max_frames_left: int,
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Read up to batch_size frames and preprocess them for detection."""
    raw_frames: list[np.ndarray] = []
    preprocessed: list[np.ndarray] = []
    for _ in range(min(batch_size, max_frames_left)):
        frame, preproc = _read_and_preprocess_frame(pipe, segment)
        if frame is None or preproc is None:
            break
        raw_frames.append(frame)
        preprocessed.append(preproc)
    return raw_frames, preprocessed


def _build_decoded_batch(
    *,
    frame_idx_start: int,
    frames: list[np.ndarray],
    detector_inputs: list[np.ndarray],
) -> _DecodedBatch:
    """Package one decoded batch for the detector stage."""
    return _DecodedBatch(
        frame_idx_start=frame_idx_start,
        frames=frames,
        detector_inputs=detector_inputs,
    )


def _snap_timestamp(segment: _VideoSegment, frame_idx: int) -> float:
    """Snap the decoded frame timestamp to the nearest source-frame timestamp."""
    # Align decoded timestamps to the source frame grid.
    raw_ts = segment.start_time + frame_idx * segment.frame_interval
    return round(raw_ts / segment.source_frame_duration) * segment.source_frame_duration


def _filter_small_detections(
    detections: list[Detection],
    *,
    min_bbox_ratio: float,
    frame_width: int,
    frame_height: int,
) -> list[Detection]:
    """Drop detections whose long edge is below the configured size ratio."""
    if min_bbox_ratio <= 0:
        return detections

    frame_max_dim = max(frame_width, frame_height)
    return [
        det
        for det in detections
        if max(
            det.bbox_xyxy[2] - det.bbox_xyxy[0],
            det.bbox_xyxy[3] - det.bbox_xyxy[1],
        )
        / frame_max_dim
        >= min_bbox_ratio
    ]


def _collect_reference_patches(
    reference_patch_requests: list[ReferencePatchRequest] | None,
    *,
    timestamp: float,
    frame: np.ndarray,
    frame_width: int,
    frame_height: int,
    frame_interval: float,
    matched_indices: set[int],
) -> tuple[list[ReferencePatch], set[int]]:
    """Return reference patches and newly matched request indices for one frame."""
    output: list[ReferencePatch] = []
    newly_matched: set[int] = set()
    if not reference_patch_requests:
        return output, newly_matched

    for request_idx, patch_request in enumerate(reference_patch_requests):
        if request_idx in matched_indices:
            continue
        if abs(timestamp - patch_request.timestamp) >= frame_interval / 2:
            continue

        y_min, x_min, y_max, x_max = patch_request.bbox_xyxy
        patch_b64 = crop_patch_b64(
            frame,
            [
                x_min / 1000.0 * frame_width,
                y_min / 1000.0 * frame_height,
                x_max / 1000.0 * frame_width,
                y_max / 1000.0 * frame_height,
            ],
            expansion=PREDICTED_BBOX_EXPANSION,
        )
        if patch_b64:
            output.append(
                ReferencePatch(
                    reference_id=patch_request.reference_id,
                    timestamp=timestamp,
                    bbox_xyxy=patch_request.bbox_xyxy,
                    patch_b64=patch_b64,
                )
            )
            newly_matched.add(request_idx)

    return output, newly_matched


def _build_tracker_runtime(req: ExtractPatchCandidatesRequest) -> _TrackerRuntime:
    """Build tracker instance and finalize settings from the request."""
    app_w = req.appearance_weight if req.appearance_weight is not None else DEFAULT_APPEARANCE_WEIGHT
    mot_w = req.motion_weight if req.motion_weight is not None else DEFAULT_MOTION_WEIGHT
    max_cost = req.max_cost if req.max_cost is not None else DEFAULT_MAX_COST
    max_age_s = req.max_age_seconds if req.max_age_seconds is not None else DEFAULT_MAX_AGE_SECONDS
    min_track_s = req.min_track_seconds if req.min_track_seconds is not None else DEFAULT_MIN_TRACK_SECONDS
    merge_gap = req.merge_max_gap_seconds if req.merge_max_gap_seconds is not None else DEFAULT_MERGE_MAX_GAP_SECONDS
    merge_cos = req.merge_cosine_threshold if req.merge_cosine_threshold is not None else DEFAULT_MERGE_COSINE_THRESHOLD
    max_age_frames = max(1, int(max_age_s * req.fps))
    min_track_frames = max(1, int(min_track_s * req.fps))

    shot_patch_requests = None
    if req.shot_patch_requests:
        shot_patch_requests = [
            (
                shot.shot_key,
                shot.start,
                shot.end,
                set(shot.allowed_labels) if shot.allowed_labels is not None else None,
            )
            for shot in req.shot_patch_requests
        ]

    return _TrackerRuntime(
        tracker=IncrementalTracker(
            max_age=max_age_frames,
            appearance_weight=app_w,
            motion_weight=mot_w,
            max_cost=max_cost,
            shot_patch_requests=shot_patch_requests,
        ),
        min_track_frames=min_track_frames,
        merge_gap_seconds=merge_gap,
        merge_cosine_threshold=merge_cos,
    )


def _build_detected_batch(
    decoded_batch: _DecodedBatch,
    batch_dets: list[list[Detection]],
    *,
    segment: _VideoSegment,
    min_bbox_ratio: float,
) -> _DetectedBatch:
    """Attach timestamps and filtered detections to a raw detection batch."""
    detected_frames: list[_DetectedFrame] = []
    for batch_offset, frame in enumerate(decoded_batch.frames):
        frame_idx = decoded_batch.frame_idx_start + batch_offset
        detected_frames.append(
            _DetectedFrame(
                frame_idx=frame_idx,
                timestamp=_snap_timestamp(segment, frame_idx),
                frame=frame,
                detections=_filter_small_detections(
                    batch_dets[batch_offset],
                    min_bbox_ratio=min_bbox_ratio,
                    frame_width=segment.width,
                    frame_height=segment.height,
                ),
            )
        )
    return _DetectedBatch(frames=detected_frames)


def _iter_decoded_batches(
    req: ExtractPatchCandidatesRequest,
    segment: _VideoSegment,
    *,
    stats: _PipelineStats,
    started_at: float,
) -> Iterator[_DecodedBatch]:
    """Yield decoded batches from ffmpeg."""
    # Mutates stats because this generator owns decode timing across batches.
    # 1) Start ffmpeg for the requested segment.
    ffmpeg_cmd = _build_ffmpeg_cmd(req.video_path, segment)
    proc = subprocess.Popen(  # noqa: S603
        ffmpeg_cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if proc.stdout is None:
        raise RuntimeError("ffmpeg stdout pipe was not created")
    stats.ffmpeg_start_s = time.monotonic() - started_at

    try:
        frame_idx = 0
        frames_left = MAX_FRAMES_PER_REQUEST
        while frames_left > 0:
            # 2) Read one decoded batch and detector inputs.
            io_start = time.monotonic()
            frames, detector_inputs = _read_batch(
                proc.stdout,
                segment,
                GDINO_BATCH_SIZE,
                frames_left,
            )
            stats.io_wait_s += time.monotonic() - io_start
            if not frames:
                break

            # 3) Package the batch for the detector stage.
            decoded_batch = _build_decoded_batch(
                frame_idx_start=frame_idx,
                frames=frames,
                detector_inputs=detector_inputs,
            )
            yield decoded_batch

            # 4) Advance the decode stream position.
            frame_idx += decoded_batch.num_frames
            frames_left -= decoded_batch.num_frames
    finally:
        # 5) Close ffmpeg resources.
        proc.stdout.close()
        try:
            proc.wait(timeout=FFMPEG_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        finally:
            if proc.stderr:
                proc.stderr.close()


def _next_decoded_batch(decoded_batches: Iterator[_DecodedBatch]) -> _DecodedBatch | None:
    """Return the next decoded batch or None when the stream is exhausted."""
    return next(decoded_batches, None)


def _iter_detected_batches(
    decoded_batches: Iterator[_DecodedBatch],
    req: ExtractPatchCandidatesRequest,
    segment: _VideoSegment,
    *,
    stats: _PipelineStats,
) -> Iterator[_DetectedBatch]:
    """Yield detected batches while overlapping decode and Triton inference."""
    # Mutates stats because Triton submit/wait accounting lives with this scheduler.
    # 1) Acquire CUDA buffers for alternating Triton submissions.
    cuda_shm_pair = acquire_cuda_shm()

    try:
        with ThreadPoolExecutor(max_workers=1) as prefetch_exec:
            shm_a = cuda_shm_pair[0] if cuda_shm_pair else None
            shm_b = cuda_shm_pair[1] if cuda_shm_pair else None
            shm_toggle = 0

            # 2) Prime the first detection batch.
            current_batch = next(decoded_batches, None)
            gpu_future = None
            if current_batch is not None:
                submit_start = time.monotonic()
                gpu_future = submit_async_infer_batch(current_batch.detector_inputs, req.text_prompt, shm_a)
                stats.gpu_submit_s += time.monotonic() - submit_start
                stats.grpc_calls += 1

            while current_batch is not None:
                # 3) Prefetch the next decoded batch while GPU works on this one.
                next_batch_future = prefetch_exec.submit(_next_decoded_batch, decoded_batches)

                # 4) Collect detections for the current batch.
                gpu_wait_start = time.monotonic()
                batch_dets = collect_batch_detections(
                    gpu_future,
                    batch_size=current_batch.num_frames,
                    width=segment.width,
                    height=segment.height,
                    threshold=req.box_threshold,
                    nms_threshold=req.nms_threshold,
                    prompt=req.text_prompt,
                )
                stats.gpu_wait_s += time.monotonic() - gpu_wait_start

                next_batch = next_batch_future.result()

                # 5) Submit the next batch to Triton.
                if next_batch is not None:
                    submit_start = time.monotonic()
                    next_shm = shm_b if shm_toggle == 0 else shm_a
                    gpu_future = submit_async_infer_batch(next_batch.detector_inputs, req.text_prompt, next_shm)
                    stats.gpu_submit_s += time.monotonic() - submit_start
                    stats.grpc_calls += 1
                    shm_toggle = 1 - shm_toggle
                else:
                    gpu_future = None

                # 6) Attach detections to the current decoded batch.
                yield _build_detected_batch(
                    current_batch,
                    batch_dets,
                    segment=segment,
                    min_bbox_ratio=req.min_bbox_ratio,
                )

                # 7) Advance to the next decoded batch.
                current_batch = next_batch
    finally:
        # 8) Close the decode stream and release CUDA buffers.
        close_decoded_batches = getattr(decoded_batches, "close", None)
        if close_decoded_batches is not None:
            close_decoded_batches()
        if cuda_shm_pair is not None:
            release_cuda_shm(cuda_shm_pair)


def _collect_batch_reference_patches(
    batch: _DetectedBatch,
    reference_patch_requests: list[ReferencePatchRequest] | None,
    *,
    frame_interval: float,
    matched_indices: set[int],
) -> tuple[list[ReferencePatch], set[int]]:
    """Return reference patches and newly matched request indices for one detected batch."""
    if not reference_patch_requests:
        return [], set()

    output: list[ReferencePatch] = []
    batch_matched: set[int] = set()
    for detected_frame in batch.frames:
        frame_patches, frame_matched = _collect_reference_patches(
            reference_patch_requests,
            timestamp=detected_frame.timestamp,
            frame=detected_frame.frame,
            frame_width=detected_frame.frame.shape[1],
            frame_height=detected_frame.frame.shape[0],
            frame_interval=frame_interval,
            matched_indices=matched_indices | batch_matched,
        )
        output.extend(frame_patches)
        batch_matched.update(frame_matched)

    return output, batch_matched


def _flatten_patch_candidates(tracked_instances) -> list[PatchCandidate]:
    """Flatten per-instance shot patches into response patch candidates."""
    patch_candidates: list[PatchCandidate] = []
    for tracked_instance in tracked_instances:
        for shot_key, shot_patch in tracked_instance.intra_shot_patches.items():
            patch_candidates.append(
                PatchCandidate(
                    instance_id=tracked_instance.track_id,
                    shot_key=shot_key,
                    label=shot_patch.label,
                    timestamp=shot_patch.timestamp,
                    bbox_xyxy=shot_patch.bbox_xyxy,
                    confidence=shot_patch.confidence,
                    patch_b64=shot_patch.patch_b64,
                )
            )
    return patch_candidates


def _select_response_shot_keys(
    patch_candidates: list[PatchCandidate],
    *,
    max_shots_per_label: int | None,
) -> set[str]:
    """Select the union of top-confidence shot keys per label.

    This is a best-effort response-size optimization only. Once a shot is
    selected by any label, all patch candidates from that shot are retained.
    """
    if max_shots_per_label is None:
        return {candidate.shot_key for candidate in patch_candidates}

    best_confidence_by_key: dict[tuple[str, str], float] = {}
    earliest_timestamp_by_key: dict[tuple[str, str], float] = {}
    for candidate in patch_candidates:
        key = (candidate.label, candidate.shot_key)
        best_confidence_by_key[key] = max(best_confidence_by_key.get(key, 0.0), candidate.confidence)
        earliest_timestamp_by_key[key] = min(earliest_timestamp_by_key.get(key, candidate.timestamp), candidate.timestamp)

    scored_shots_by_label: dict[str, list[tuple[float, float, str]]] = {}
    for (label, shot_key), confidence in best_confidence_by_key.items():
        scored_shots_by_label.setdefault(label, []).append(
            (confidence, earliest_timestamp_by_key[label, shot_key], shot_key)
        )

    selected_shot_keys: set[str] = set()
    for scored_shots in scored_shots_by_label.values():
        scored_shots.sort(key=lambda item: (-item[0], item[1], item[2]))
        for _confidence, _timestamp, shot_key in scored_shots[:max_shots_per_label]:
            selected_shot_keys.add(shot_key)

    return selected_shot_keys


def _prune_patch_candidates_for_response(
    patch_candidates: list[PatchCandidate],
    *,
    max_shots_per_label: int | None,
) -> tuple[list[PatchCandidate], set[str]]:
    """Best-effort response pruning by unioned top-k shots per label."""
    selected_shot_keys = _select_response_shot_keys(
        patch_candidates,
        max_shots_per_label=max_shots_per_label,
    )
    pruned = [candidate for candidate in patch_candidates if candidate.shot_key in selected_shot_keys]
    return pruned, selected_shot_keys


def _push_tracker_chunk(
    tracker: IncrementalTracker,
    chunk_buffer: _TrackerChunkBuffer,
) -> float:
    """Push one ready tracker chunk and return elapsed tracker time.

    Tracker mutation is intentional: IncrementalTracker owns cross-chunk state.
    """
    if chunk_buffer.empty():
        return 0.0

    frame_detections, frame_images = chunk_buffer.take()
    tracker_start = time.monotonic()
    tracker.push_chunk(frame_detections, frame_images)
    return time.monotonic() - tracker_start


def extract_patch_candidates(req: ExtractPatchCandidatesRequest) -> ExtractPatchCandidatesResponse:
    """Pipeline: decode -> detect -> batch tracker -> flatten patch candidates."""
    t0 = time.monotonic()
    segment = _resolve_video_segment(req)
    tracker_runtime = _build_tracker_runtime(req)
    tracker = tracker_runtime.tracker
    chunk_buffer = _TrackerChunkBuffer(max_frames=GDINO_BATCH_SIZE * TRACKER_BATCH_MULTIPLIER)
    stats = _PipelineStats(ffmpeg_start_s=0.0)
    reference_patches: list[ReferencePatch] = []
    matched_reference_indices: set[int] = set()
    num_frames = 0

    # 1) Decode video frames into detector-ready batches.
    decoded_batches = _iter_decoded_batches(req, segment, stats=stats, started_at=t0)
    # 2) Run detection while prefetching the next decoded batch.
    detected_batches = _iter_detected_batches(decoded_batches, req, segment, stats=stats)

    # 3) Feed detected batches into the tracker pipeline.
    for detected_batch in detected_batches:
        num_frames += detected_batch.num_frames

        # 4) Collect optional reference patches from detected frames.
        batch_patches, batch_matched = _collect_batch_reference_patches(
            detected_batch,
            req.reference_patch_requests,
            frame_interval=segment.frame_interval,
            matched_indices=matched_reference_indices,
        )
        reference_patches.extend(batch_patches)
        matched_reference_indices.update(batch_matched)

        # 5) Buffer frames until one tracker chunk is ready.
        chunk_buffer.add_batch(detected_batch)

        # 6) Push a ready chunk into the tracker.
        if chunk_buffer.ready():
            stats.tracker_s += _push_tracker_chunk(tracker, chunk_buffer)

    # 7) Push the final partial tracker chunk.
    if not chunk_buffer.empty():
        stats.tracker_s += _push_tracker_chunk(tracker, chunk_buffer)

    # 8) Finish the last pending tracker chunk.
    tracker_start = time.monotonic()
    tracker.flush()
    stats.tracker_s += time.monotonic() - tracker_start

    if num_frames == 0:
        return ExtractPatchCandidatesResponse(
            patch_candidates=[],
            num_frames_processed=0,
            elapsed_s=round(time.monotonic() - t0, 3),
        )

    # 9) Finalize and optionally merge tracked instances.
    tracked_instances = tracker.finalize(
        min_track_length=tracker_runtime.min_track_frames,
        merge_max_gap_seconds=tracker_runtime.merge_gap_seconds,
        merge_cosine_threshold=tracker_runtime.merge_cosine_threshold,
    )
    patch_candidates = _flatten_patch_candidates(tracked_instances)
    patch_candidates, selected_shot_keys = _prune_patch_candidates_for_response(
        patch_candidates,
        max_shots_per_label=req.max_shots_per_label,
    )
    elapsed = round(time.monotonic() - t0, 3)
    timings = tracker._timings
    logger.info(
        "extract_patch_candidates [triton]: %d frames, %d patch candidates from %d tracked instances across %d response shots in %.1fs (%.1f fps) | "
        "batch=%d grpc_calls=%d | gpu_wait=%.3fs gpu_submit=%.3fs io_wait=%.3fs tracker=%.3fs | "
        "tracker breakdown: reid=%.3fs crop=%.3fs kalman=%.3fs match=%.3fs",
        num_frames,
        len(patch_candidates),
        len(tracked_instances),
        len(selected_shot_keys),
        elapsed,
        num_frames / elapsed if elapsed > 0 else 0,
        GDINO_BATCH_SIZE,
        stats.grpc_calls,
        stats.gpu_wait_s,
        stats.gpu_submit_s,
        stats.io_wait_s,
        stats.tracker_s,
        timings.get("reid_infer", 0),
        timings.get("crop_extract", 0),
        timings.get("kalman_predict", 0),
        timings.get("match_frame", 0),
    )

    return ExtractPatchCandidatesResponse(
        patch_candidates=patch_candidates,
        num_frames_processed=num_frames,
        elapsed_s=elapsed,
        profiling=ProfilingData(
            batch_size=GDINO_BATCH_SIZE,
            num_grpc_calls=stats.grpc_calls,
            gpu_wait_s=round(stats.gpu_wait_s, 4),
            gpu_submit_s=round(stats.gpu_submit_s, 4),
            io_wait_s=round(stats.io_wait_s, 4),
            tracker_s=round(stats.tracker_s, 4),
            ffmpeg_start_s=round(stats.ffmpeg_start_s, 4),
            tracker_reid_s=round(timings.get("reid_infer", 0), 4),
            tracker_reid_submit_s=round(timings.get("reid_submit", 0), 4),
            tracker_crop_s=round(timings.get("crop_extract", 0), 4),
            tracker_kalman_s=round(timings.get("kalman_predict", 0), 4),
            tracker_match_s=round(timings.get("match_frame", 0), 4),
        ),
        reference_patches=reference_patches,
    )
