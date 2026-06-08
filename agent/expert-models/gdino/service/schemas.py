"""Request/response schemas for the Grounding DINO expert model server."""

from __future__ import annotations

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Detection primitives
# ---------------------------------------------------------------------------


class Detection(BaseModel):
    """A single detected object in one frame."""

    bbox_xyxy: list[float] = Field(description="[x_min, y_min, x_max, y_max] in pixels")
    confidence: float
    label: str


class FrameDetections(BaseModel):
    """All detections for a single frame."""

    frame_idx: int
    timestamp: float
    detections: list[Detection]


# ---------------------------------------------------------------------------
# Tracker internals
# ---------------------------------------------------------------------------


class TrackDetection(BaseModel):
    """A single detection within a track."""

    frame_idx: int
    timestamp: float
    bbox_xyxy: list[float]
    confidence: float
    label: str


class ShotPatch(BaseModel):
    """Best-confidence crop within a shot window for one tracked instance."""

    label: str = Field(description="Winning GDINO label for this shot patch")
    patch_b64: str = Field(description="Base64 JPEG crop (1.3x expansion)")
    timestamp: float = Field(description="Timestamp of the frame used for cropping")
    bbox_xyxy: list[float] = Field(description="[x1, y1, x2, y2] detection bbox in pixel coords")
    confidence: float = Field(description="GDINO detection confidence")


# ---------------------------------------------------------------------------
# /extract_patch_candidates
# ---------------------------------------------------------------------------


class ShotPatchRequest(BaseModel):
    """A shot request for tracked patch extraction."""

    shot_key: str = Field(description="Stable client-provided key for this shot window")
    start: float = Field(description="Shot start in seconds (absolute)")
    end: float = Field(description="Shot end in seconds (absolute)")
    allowed_labels: list[str] | None = Field(
        default=None,
        description="Optional label allowlist for this shot window. When present, only matching labels become patch candidates.",
    )


class ReferencePatchRequest(BaseModel):
    """A reference bbox location to crop from a decoded frame."""

    reference_id: str = Field(description="Stable client-provided identifier for this reference patch")
    timestamp: float = Field(description="Predicted timestamp in seconds (absolute)")
    bbox_xyxy: list[float] = Field(description="[y_min, x_min, y_max, x_max] in 0-1000 normalized coords")


class ReferencePatch(BaseModel):
    """Server-returned crop for a requested reference patch."""

    reference_id: str
    timestamp: float
    bbox_xyxy: list[float]
    patch_b64: str = Field(description="Base64 JPEG crop at the nearest decoded frame")


class PatchCandidate(BaseModel):
    """One patch candidate for a tracked instance within a shot request."""

    instance_id: int = Field(description="Stable tracked-instance identifier within this response")
    shot_key: str = Field(description="Shot request key this candidate belongs to")
    label: str = Field(description="Winning GDINO label for this shot patch")
    timestamp: float = Field(description="Timestamp of the frame used for cropping")
    bbox_xyxy: list[float] = Field(description="[x1, y1, x2, y2] in pixel coords")
    confidence: float = Field(description="GDINO detection confidence")
    patch_b64: str = Field(description="Base64 JPEG crop (1.3x expansion)")


class VideoMetadata(BaseModel):
    """Client-provided video metadata used to skip ffprobe."""

    raw_width: int = Field(gt=0, description="Source video width in pixels")
    raw_height: int = Field(gt=0, description="Source video height in pixels")
    video_duration: float = Field(gt=0, description="Source video duration in seconds")
    source_fps: float = Field(gt=0, description="Source video frame rate in frames per second")


class ExtractPatchCandidatesRequest(BaseModel):
    """Request to extract patch candidates from a video."""

    video_path: str = Field(description="Local path, S3 URI, or presigned URL")
    video_metadata: VideoMetadata | None = Field(
        default=None,
        description="Optional client-provided metadata to avoid an ffprobe round trip.",
    )
    text_prompt: str = Field(
        default="person.",
        description="Period-separated noun phrases for GDINO (e.g. 'person. cat.')",
    )
    fps: float = Field(default=2.0, description="Frame extraction rate")
    box_threshold: float = 0.15
    # Detection config
    nms_threshold: float = Field(default=0.5, description="NMS IoU threshold to deduplicate overlapping detections")
    min_bbox_ratio: float = Field(
        default=0.10,
        description="Minimum ratio of detection's longer edge to frame's longer edge. "
                    "Detections smaller than this are filtered before tracking. 0 = no filtering.",
    )
    # Tracker config
    appearance_weight: float | None = Field(default=None, description="Re-ID appearance weight in cost matrix (default from env TRACKER_APPEARANCE_WEIGHT or 0.6)")
    motion_weight: float | None = Field(default=None, description="Motion/IoU weight in cost matrix (default from env TRACKER_MOTION_WEIGHT or 0.4)")
    max_cost: float | None = Field(default=None, description="Max acceptable cost to match detection to track (default from env TRACKER_MAX_COST or 0.7)")
    max_age_seconds: float | None = Field(default=None, description="Seconds without match before track ends (default from env TRACKER_MAX_AGE_SECONDS or 10.0)")
    min_track_seconds: float | None = Field(default=None, description="Minimum track duration in seconds (default from env TRACKER_MIN_TRACK_SECONDS or 1.5)")
    merge_max_gap_seconds: float | None = Field(default=None, description="Max gap between tracks to merge by Re-ID. 0=disabled. (default from env TRACKER_MERGE_MAX_GAP_SECONDS or 0)")
    merge_cosine_threshold: float | None = Field(default=None, description="Max cosine distance to merge tracks. 0=disabled. (default from env TRACKER_MERGE_COSINE_THRESHOLD or 0)")
    # Time range for segment processing
    start_time: float | None = Field(default=None, description="Start of segment in seconds (absolute). None = beginning of video.")
    end_time: float | None = Field(default=None, description="End of segment in seconds (absolute). None = end of video.")
    # Intra-shot patches + predicted bbox crops
    shot_patch_requests: list[ShotPatchRequest] | None = Field(
        default=None,
        description="Shot patch requests. Server returns one patch candidate per tracked instance within each shot.",
    )
    reference_patch_requests: list[ReferencePatchRequest] | None = Field(
        default=None,
        description="Reference bbox locations to crop from decoded frames (0-1000 normalized coords).",
    )
    max_shots_per_label: int | None = Field(
        default=3,
        gt=0,
        description=(
            "Optional best-effort response pruning. Keep the union of the top-confidence "
            "shot keys per label, then return all patch candidates from those shots."
        ),
    )


class ProfilingData(BaseModel):
    """Per-phase timing breakdown from the patch-candidate extraction pipeline."""

    batch_size: int = Field(description="GDINO batch size used for this request")
    num_grpc_calls: int = Field(description="Total number of Triton gRPC calls made")
    gpu_wait_s: float = Field(description="Total time waiting for GPU inference results")
    gpu_submit_s: float = Field(description="Total time submitting GPU inference requests")
    io_wait_s: float = Field(description="Total time reading + preprocessing frames")
    tracker_s: float = Field(description="Total time in tracker (Re-ID + matching)")
    ffmpeg_start_s: float = Field(description="Time to start ffmpeg and read first frame")
    # Tracker sub-phase breakdown
    tracker_reid_s: float = Field(default=0, description="Time waiting for Re-ID inference result within tracker")
    tracker_reid_submit_s: float = Field(default=0, description="Time submitting async Re-ID within tracker")
    tracker_crop_s: float = Field(default=0, description="Time extracting crops within tracker")
    tracker_kalman_s: float = Field(default=0, description="Time in Kalman predict within tracker")
    tracker_match_s: float = Field(default=0, description="Time in matching within tracker")


class ExtractPatchCandidatesResponse(BaseModel):
    """Response containing flattened patch candidates and reference crops."""

    patch_candidates: list[PatchCandidate]
    num_frames_processed: int
    elapsed_s: float
    profiling: ProfilingData | None = None
    reference_patches: list[ReferencePatch] = Field(default_factory=list)
