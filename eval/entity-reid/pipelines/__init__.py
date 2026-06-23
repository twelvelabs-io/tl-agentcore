"""Pipeline registry. Each entry is the class itself, loaded lazily so a
missing optional dep (e.g. an AWS client config) doesn't break the whole
import."""

from __future__ import annotations

from importlib import import_module


def get(name: str):
    mod = import_module(f"pipelines.{name}")
    return mod.PIPELINE


REGISTRY = {
    "current_titan": "current_titan",
    "rekognition_faces": "rekognition_faces",
    "nova_mm_embed": "nova_mm_embed",
    "marengo_clips": "marengo_clips",
}
