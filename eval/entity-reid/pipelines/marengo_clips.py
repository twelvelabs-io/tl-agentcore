"""Marengo + production clips index pipeline. No ingest — queries the
live `clips` S3 Vectors index that the auto-pipeline populates on every
upload (per-segment visual / audio / transcription embeddings).

Marengo on Bedrock doesn't accept image input synchronously; we use
StartAsyncInvoke against the foundation-model ARN with `inputType:
image` and poll for the output S3 location. ~3-5 s per query.

The clips index is 512-dim. Per-vector metadata carries
`embedding_option` (visual/audio/transcription) plus `asset_id`,
`knowledge_store_id`, `start_sec`, `end_sec`. For face queries we
filter to `embedding_option = visual`.

Env vars:
  AWS_REGION             default us-east-1
  AWS_ACCOUNT_ID         needed for the s3Location.bucketOwner field
  VECTOR_BUCKET_NAME
  VECTOR_INDEX_NAME      default "clips"
  CLIPS_BUCKET_NAME      used for the temporary async-in image upload
  KS_ID                  filter on knowledge_store_id metadata
  MARENGO_MODEL_ARN      default twelvelabs.marengo-embed-3-0-v1:0 foundation ARN
"""

from __future__ import annotations

import io
import json
import os
import time
import uuid

import boto3
from botocore.exceptions import ClientError
from PIL import Image

from .base import Pipeline, dedupe_by_asset

MIN_DIM = 128
ASYNC_TIMEOUT_S = 120


class MarengoClipsPipeline(Pipeline):
    name = "marengo_clips"

    def __init__(
        self,
        region: str | None = None,
        bucket: str | None = None,
        index: str | None = None,
        clips_bucket: str | None = None,
        ks_id: str | None = None,
    ):
        self.region = region or os.environ.get("AWS_REGION", "us-east-1")
        self.bucket = bucket or os.environ["VECTOR_BUCKET_NAME"]
        self.index = index or os.environ.get("MARENGO_INDEX_NAME", "clips")
        self.clips_bucket = clips_bucket or os.environ["CLIPS_BUCKET_NAME"]
        self.ks_id = ks_id or os.environ.get("KS_ID")
        self.account_id = os.environ.get("AWS_ACCOUNT_ID")
        self.model_arn = os.environ.get(
            "MARENGO_MODEL_ARN",
            "arn:aws:bedrock:us-east-1::foundation-model/twelvelabs.marengo-embed-3-0-v1:0",
        )
        self._br = boto3.client("bedrock-runtime", region_name=self.region)
        self._s3 = boto3.client("s3", region_name=self.region)
        self._s3v = boto3.client("s3vectors", region_name=self.region)

    def ingest(self, ks_id: str, max_assets: int | None = None, asset_ids: list[str] | None = None) -> None:
        # Reads the production clips index. Nothing to ingest.
        return

    def _ensure_min_dim(self, image_bytes: bytes) -> bytes:
        """Marengo requires images ≥128×128. Upscale (preserving aspect)
        if either dim is below the threshold."""
        im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = im.size
        if w >= MIN_DIM and h >= MIN_DIM:
            return image_bytes
        scale = max(MIN_DIM / w, MIN_DIM / h)
        new_size = (max(MIN_DIM, int(w * scale)), max(MIN_DIM, int(h * scale)))
        resized = im.resize(new_size, Image.LANCZOS)
        buf = io.BytesIO()
        resized.save(buf, format="JPEG", quality=90)
        return buf.getvalue()

    def _marengo_embed_image(self, image_bytes: bytes) -> list[float]:
        """StartAsyncInvoke with image input, poll, parse the 512-dim visual embedding."""
        if not self.account_id:
            raise RuntimeError("AWS_ACCOUNT_ID required for Marengo s3Location.bucketOwner")
        image_bytes = self._ensure_min_dim(image_bytes)
        key = f"async-in-eval/{uuid.uuid4().hex}.jpg"
        self._s3.put_object(Bucket=self.clips_bucket, Key=key, Body=image_bytes, ContentType="image/jpeg")

        body = {
            "inputType": "image",
            "image": {
                "mediaSource": {
                    "s3Location": {
                        "uri": f"s3://{self.clips_bucket}/{key}",
                        "bucketOwner": self.account_id,
                    }
                }
            },
        }
        resp = self._br.start_async_invoke(
            modelId=self.model_arn,
            modelInput=body,
            outputDataConfig={"s3OutputDataConfig": {"s3Uri": f"s3://{self.clips_bucket}/async-out-eval/"}},
        )
        arn = resp["invocationArn"]
        t0 = time.time()
        while time.time() - t0 < ASYNC_TIMEOUT_S:
            s = self._br.get_async_invoke(invocationArn=arn)
            status = s["status"]
            if status == "Completed":
                out_uri = s["outputDataConfig"]["s3OutputDataConfig"]["s3Uri"]
                # Marengo writes <prefix>/output.json next to the invocation.
                bucket = out_uri.split("/")[2]
                prefix = "/".join(out_uri.split("/")[3:])
                listing = self._s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
                for obj in listing.get("Contents", []):
                    if obj["Key"].endswith("output.json"):
                        data = json.loads(self._s3.get_object(Bucket=bucket, Key=obj["Key"])["Body"].read())
                        # Image input returns one segment in data[0].
                        seg = (data.get("data") or [{}])[0]
                        v = seg.get("embedding") or []
                        if not v:
                            raise RuntimeError(f"Marengo returned no embedding: {json.dumps(data)[:300]}")
                        return v
                raise RuntimeError(f"output.json not found under {out_uri}")
            if status == "Failed":
                raise RuntimeError(f"Marengo async failed: {s.get('failureMessage')}")
            time.sleep(2)
        raise TimeoutError(f"Marengo async invocation timed out after {ASYNC_TIMEOUT_S}s")

    def query(self, query_image_bytes: bytes, k: int = 50) -> list[tuple[str, float]]:
        qvec = self._marengo_embed_image(query_image_bytes)

        filt = {"embedding_option": "visual"}
        if self.ks_id:
            filt = {"$and": [filt, {"knowledge_store_id": self.ks_id}]}

        try:
            resp = self._s3v.query_vectors(
                vectorBucketName=self.bucket,
                indexName=self.index,
                topK=k * 8,  # over-fetch hard; many segments collapse per asset
                queryVector={"float32": qvec},
                filter=filt,
                returnMetadata=True,
                returnDistance=True,
            )
        except ClientError as e:
            raise RuntimeError(f"clips QueryVectors failed: {e}") from e

        hits = []
        for v in resp.get("vectors", []):
            md = v.get("metadata") or {}
            asset_id = md.get("asset_id")
            if not asset_id:
                continue
            score = 1.0 - float(v.get("distance", 1.0))
            hits.append((asset_id, score))
        return dedupe_by_asset(hits)[:k]


PIPELINE = MarengoClipsPipeline()
