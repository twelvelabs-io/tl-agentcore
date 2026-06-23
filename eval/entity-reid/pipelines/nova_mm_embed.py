"""Nova Multimodal Embeddings pipeline. Sampled frames per asset are
embedded with `amazon.nova-2-multimodal-embeddings-v1:0` using the
asymmetric purpose pair (GENERIC_INDEX at ingest, IMAGE_RETRIEVAL at
query) and stored in a dedicated S3 Vectors index named
`<NOVA_INDEX>` (created on demand at ingest).

Env vars:
  AWS_REGION                 default us-east-1
  VECTOR_BUCKET_NAME         S3 Vectors bucket
  NOVA_INDEX                 index name; default "eval-nova-mm-1024"
  NOVA_DIM                   one of 256/384/1024/3072 (default 1024)
  CLIPS_BUCKET_NAME          where MediaConvert frame captures live
  ASSETS_TABLE               DDB assets table; for enumerating KS members
  FRAMES_PER_ASSET           default 5
"""

from __future__ import annotations

import base64
import json
import os
from typing import Iterable

import boto3
from botocore.exceptions import ClientError

from .base import Pipeline, dedupe_by_asset

NOVA_MODEL_ID = "amazon.nova-2-multimodal-embeddings-v1:0"


class NovaMMEmbedPipeline(Pipeline):
    name = "nova_mm_embed"

    def __init__(
        self,
        bucket: str | None = None,
        index: str | None = None,
        dim: int | None = None,
        region: str | None = None,
    ):
        self.region = region or os.environ.get("AWS_REGION", "us-east-1")
        self.bucket = bucket or os.environ["VECTOR_BUCKET_NAME"]
        self.index = index or os.environ.get("NOVA_INDEX", "eval-nova-mm-1024")
        self.dim = int(dim or os.environ.get("NOVA_DIM", "1024"))
        self.clips_bucket = os.environ.get("CLIPS_BUCKET_NAME")
        self.assets_table = os.environ.get("ASSETS_TABLE")
        self.frames_per_asset = int(os.environ.get("FRAMES_PER_ASSET", "5"))
        self._br = boto3.client("bedrock-runtime", region_name=self.region)
        self._s3 = boto3.client("s3", region_name=self.region)
        self._s3v = boto3.client("s3vectors", region_name=self.region)
        self._ddb = boto3.client("dynamodb", region_name=self.region)

    def _ensure_index(self) -> None:
        try:
            self._s3v.create_index(
                vectorBucketName=self.bucket,
                indexName=self.index,
                dimension=self.dim,
                dataType="float32",
                distanceMetric="cosine",
                # frame_key isn't useful as a filter — mark non-filterable
                # so it doesn't count against the per-vector filterable cap.
                metadataConfiguration={"nonFilterableMetadataKeys": ["frame_key"]},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConflictException":
                raise

    def _iter_assets(self, ks_id: str) -> Iterable[str]:
        paginator = self._ddb.get_paginator("query")
        for page in paginator.paginate(
            TableName=self.assets_table,
            IndexName="by-ks",
            KeyConditionExpression="knowledge_store_id = :k",
            ExpressionAttributeValues={":k": {"S": ks_id}},
        ):
            for item in page.get("Items", []):
                yield item["asset_id"]["S"]

    def _frame_keys(self, asset_id: str) -> list[str]:
        """Layout: hls/<asset_id>/<asset_id>_thumb.NNNNNNN.jpg."""
        prefix = f"hls/{asset_id}/"
        resp = self._s3.list_objects_v2(Bucket=self.clips_bucket, Prefix=prefix)
        keys = sorted(
            o["Key"] for o in resp.get("Contents", [])
            if "_thumb." in o["Key"] and o["Key"].lower().endswith((".jpg", ".jpeg", ".png"))
        )
        if len(keys) <= self.frames_per_asset:
            return keys
        step = len(keys) / self.frames_per_asset
        return [keys[int(i * step)] for i in range(self.frames_per_asset)]

    def _embed(self, image_bytes: bytes, purpose: str) -> list[float]:
        """Nova MM Embed — image-only, single embedding. `purpose` is
        GENERIC_INDEX at ingest, IMAGE_RETRIEVAL at query."""
        fmt = _detect_format(image_bytes)
        body = {
            "schemaVersion": "nova-multimodal-embed-v1",
            "taskType": "SINGLE_EMBEDDING",
            "singleEmbeddingParams": {
                "embeddingPurpose": purpose,
                "embeddingDimension": self.dim,
                "image": {
                    "format": fmt,
                    "source": {"bytes": base64.b64encode(image_bytes).decode("ascii")},
                },
            },
        }
        resp = self._br.invoke_model(
            modelId=NOVA_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(resp["body"].read())
        return payload["embeddings"][0]["embedding"]

    def ingest(self, ks_id: str, max_assets: int | None = None, asset_ids: list[str] | None = None) -> None:
        if not (self.clips_bucket and self.assets_table):
            raise RuntimeError("CLIPS_BUCKET_NAME + ASSETS_TABLE env vars are required")
        self._ensure_index()
        n_assets = 0
        source = iter(asset_ids) if asset_ids is not None else self._iter_assets(ks_id)
        for asset_id in source:
            if asset_ids is None and max_assets is not None and n_assets >= max_assets:
                break
            vectors = []
            for i, key in enumerate(self._frame_keys(asset_id)):
                try:
                    img = self._s3.get_object(Bucket=self.clips_bucket, Key=key)["Body"].read()
                    vec = self._embed(img, purpose="GENERIC_INDEX")
                except Exception as e:
                    print(f"  ! embed({asset_id} / {key}): {e}")
                    continue
                vectors.append({
                    "key": f"{asset_id}#{i}",
                    "data": {"float32": vec},
                    "metadata": {"asset_id": asset_id, "knowledge_store_id": ks_id, "frame_key": key},
                })
            if vectors:
                self._s3v.put_vectors(
                    vectorBucketName=self.bucket, indexName=self.index, vectors=vectors,
                )
            n_assets += 1
            if n_assets % 25 == 0:
                print(f"  · {n_assets} assets embedded")
        print(f"  ✓ {n_assets} assets embedded into {self.index}")

    def query(self, query_image_bytes: bytes, k: int = 50) -> list[tuple[str, float]]:
        qvec = self._embed(query_image_bytes, purpose="IMAGE_RETRIEVAL")
        resp = self._s3v.query_vectors(
            vectorBucketName=self.bucket,
            indexName=self.index,
            topK=k * 4,
            queryVector={"float32": qvec},
            returnMetadata=True,
            returnDistance=True,
        )
        hits = []
        for v in resp.get("vectors", []):
            asset_id = (v.get("metadata") or {}).get("asset_id")
            if not asset_id:
                continue
            score = 1.0 - float(v.get("distance", 1.0))
            hits.append((asset_id, score))
        return dedupe_by_asset(hits)[:k]


def _detect_format(b: bytes) -> str:
    """Tiny magic-byte sniff so we don't pull pillow in the hot path."""
    if b[:2] == b"\xff\xd8":
        return "jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return "jpeg"  # fallback; Nova will error if wrong


PIPELINE = NovaMMEmbedPipeline()
