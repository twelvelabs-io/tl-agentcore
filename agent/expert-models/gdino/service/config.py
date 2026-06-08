"""Configuration for the Triton-backed GDINO service.

This module intentionally includes both:
1. deployment/runtime behavior config
2. fixed model/internal constants

They are kept together for discoverability, but split into separate sections below.
"""

from __future__ import annotations

import os
import numpy as np


# ---------------------------------------------------------------------------
# Deployment / runtime behavior
# ---------------------------------------------------------------------------

TRACKER_TYPE = os.environ.get("TRACKER_TYPE", "deepsort")
DEFAULT_PROMPT = os.environ.get("TEXT_PROMPT", "person.")
TRITON_GRPC_URL = os.environ.get("TRITON_GRPC_URL", "localhost:8002")
TRITON_MODEL_NAME = "gdino_dynamic"
REID_MODEL_NAME = "reid"

DEFAULT_APPEARANCE_WEIGHT = float(os.environ.get("TRACKER_APPEARANCE_WEIGHT", "0.6"))
DEFAULT_MOTION_WEIGHT = float(os.environ.get("TRACKER_MOTION_WEIGHT", "0.4"))
DEFAULT_MAX_COST = float(os.environ.get("TRACKER_MAX_COST", "0.7"))
DEFAULT_MAX_AGE_SECONDS = float(os.environ.get("TRACKER_MAX_AGE_SECONDS", "10.0"))
DEFAULT_MIN_TRACK_SECONDS = float(os.environ.get("TRACKER_MIN_TRACK_SECONDS", "1.5"))
DEFAULT_MERGE_MAX_GAP_SECONDS = float(os.environ.get("TRACKER_MERGE_MAX_GAP_SECONDS", "0"))
DEFAULT_MERGE_COSINE_THRESHOLD = float(os.environ.get("TRACKER_MERGE_COSINE_THRESHOLD", "0"))

FFMPEG_TIMEOUT_SECONDS = 300
MAX_IMAGE_DIMENSION = 1280
MAX_FRAMES_PER_REQUEST = 3000
MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES = int(os.environ.get("MAX_CONCURRENT_EXTRACT_PATCH_CANDIDATES", "2"))
MAX_QUEUE_WAIT_SECONDS = int(os.environ.get("MAX_QUEUE_WAIT_SECONDS", "300"))

GDINO_TRITON_MAX_BATCH = 8
GDINO_BATCH_SIZE = int(os.environ.get("GDINO_BATCH_SIZE", "4"))
TRACKER_BATCH_MULTIPLIER = int(os.environ.get("TRACKER_BATCH_MULTIPLIER", "8"))
MAX_AGE = 30  # frames without match before track dies
MIN_HITS = 3  # minimum detections to confirm a track
FEATURE_GALLERY_SIZE = 100
REID_MAX_BATCH = 64
SHOT_TOLERANCE_S = 1.0  # seconds of slack for matching detections to shot intervals

if not 1 <= GDINO_BATCH_SIZE <= GDINO_TRITON_MAX_BATCH:
    raise ValueError(
        f"GDINO_BATCH_SIZE must be between 1 and {GDINO_TRITON_MAX_BATCH}, got {GDINO_BATCH_SIZE}"
    )


# ---------------------------------------------------------------------------
# Fixed model / internal constants
# ---------------------------------------------------------------------------

GDINO_INPUT_HEIGHT = 544
GDINO_INPUT_WIDTH = 960
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

REID_INPUT_H = 256
REID_INPUT_W = 128

MAX_MAHALANOBIS_DIST = 9.4877  # chi-squared 95% for 4 DOF
BEST_PATCH_EXPANSION = 1.3
PREDICTED_BBOX_EXPANSION = 1.5
