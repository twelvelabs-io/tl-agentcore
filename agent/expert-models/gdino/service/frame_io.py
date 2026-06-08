"""Video decoding helpers for the Triton-backed GDINO service."""

from __future__ import annotations

import json
import subprocess

from .config import MAX_IMAGE_DIMENSION


def build_http_input_args(video_path: str) -> list[str]:
    """Return ffmpeg/ffprobe reconnect args for HTTP inputs."""
    if video_path.startswith(("http://", "https://")):
        return ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
    return []


def build_scale_filter() -> str:
    """Return the shared ffmpeg scale filter used by the service."""
    width_expr = f"if(gte(iw,ih),min({MAX_IMAGE_DIMENSION},iw),-2)"
    height_expr = f"if(gte(ih,iw),min({MAX_IMAGE_DIMENSION},ih),-2)"
    return (
        f"scale='{width_expr}':'{height_expr}'"
    )


def probe_video_metadata(video_path: str) -> tuple[int, int, float, float]:
    """Probe video dimensions, duration, and source fps in one ffprobe call."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        *build_http_input_args(video_path),
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate:format=duration",
        "-of",
        "json",
        video_path,
    ]
    result = subprocess.run(  # noqa: S603
        cmd,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        check=False,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.decode(errors='replace')[:500]}")

    data = json.loads(result.stdout)
    stream = data["streams"][0]
    width = int(stream["width"])
    height = int(stream["height"])
    duration = float(data["format"]["duration"])
    fps_str = stream.get("r_frame_rate", "30/1")
    num, den = fps_str.split("/")
    source_fps = float(num) / max(float(den), 1e-6)
    return width, height, duration, source_fps


def compute_scaled_dimensions(raw_w: int, raw_h: int) -> tuple[int, int]:
    """Compute the ffmpeg-scaled output dimensions for decoded frames."""
    if raw_w > raw_h:
        out_w = min(MAX_IMAGE_DIMENSION, raw_w)
        scale = out_w / raw_w
        out_h = int(raw_h * scale)
        out_h = out_h - (out_h % 2)
    elif raw_h > raw_w:
        out_h = min(MAX_IMAGE_DIMENSION, raw_h)
        scale = out_h / raw_h
        out_w = int(raw_w * scale)
        out_w = out_w - (out_w % 2)
    else:
        out_w = min(MAX_IMAGE_DIMENSION, raw_w)
        out_h = out_w
    return out_w, out_h
