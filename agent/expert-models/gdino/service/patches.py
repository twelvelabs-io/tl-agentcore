"""Shared image patch helpers for the GDINO service."""

from __future__ import annotations

import base64
import logging

import cv2
import numpy as np

from .config import BEST_PATCH_EXPANSION

logger = logging.getLogger(__name__)


def crop_patch_b64(
    img: np.ndarray, bbox_xyxy: list[float], expansion: float = BEST_PATCH_EXPANSION
) -> str | None:
    """Crop a bbox from a frame with expansion and encode as base64 JPEG.

    Returns None if the expanded crop has zero area (e.g., bbox at frame edge).
    """
    h_img, w_img = img.shape[:2]
    x1, y1, x2, y2 = bbox_xyxy
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    bw, bh = (x2 - x1) * expansion, (y2 - y1) * expansion

    cx1 = max(0, int(cx - bw / 2))
    cy1 = max(0, int(cy - bh / 2))
    cx2 = min(w_img, int(cx + bw / 2))
    cy2 = min(h_img, int(cy + bh / 2))

    if cx2 <= cx1 or cy2 <= cy1:
        logger.warning(
            "Zero-area crop after expansion: bbox=%s, frame=%dx%d", bbox_xyxy, w_img, h_img
        )
        return None

    crop = img[cy1:cy2, cx1:cx2]
    crop_bgr = cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
    _, buf = cv2.imencode(".jpg", crop_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return base64.b64encode(buf.tobytes()).decode("ascii")
