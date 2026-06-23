"""Production Titan + S3 Vectors pipeline. No ingest — reads the
already-populated entity-thumbs / entity-patches index that the
entity_reid Step Function maintains.

Env vars:
  AWS_REGION             default us-east-1
  VECTOR_BUCKET_NAME     S3 Vectors bucket (terraform output: vector_bucket_name)
  VECTOR_INDEX_NAME      defaults to "entity-thumbs"
  KS_ID                  knowledge_store_id metadata filter
"""

from __future__ import annotations

import base64
import json
import os

import boto3

from .base import Pipeline, dedupe_by_asset


class CurrentTitanPipeline(Pipeline):
    name = "current_titan"

    def __init__(
        self,
        bucket: str | None = None,
        index: str | None = None,
        ks_id: str | None = None,
        region: str | None = None,
    ):
        self.region = region or os.environ.get("AWS_REGION", "us-east-1")
        self.bucket = bucket or os.environ["VECTOR_BUCKET_NAME"]
        # Default to entity-patches (the index populated by the production
        # gdino+TAO+Titan Step Function). Override with TITAN_INDEX_NAME.
        self.index = index or os.environ.get("TITAN_INDEX_NAME", "entity-patches")
        self.ks_id = ks_id or os.environ.get("KS_ID")
        self._br = boto3.client("bedrock-runtime", region_name=self.region)
        self._s3v = boto3.client("s3vectors", region_name=self.region)

    def ingest(self, ks_id: str, max_assets: int | None = None, asset_ids: list[str] | None = None) -> None:
        # No-op — the production entity_reid Step Function populates this
        # index outside the eval tooling.
        return

    def query(self, query_image_bytes: bytes, k: int = 50) -> list[tuple[str, float]]:
        b64 = base64.b64encode(query_image_bytes).decode("ascii")
        body = {"inputImage": b64, "embeddingConfig": {"outputEmbeddingLength": 1024}}
        resp = self._br.invoke_model(
            modelId="amazon.titan-embed-image-v1",
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(resp["body"].read())
        qvec = payload["embedding"]

        filt = {"knowledge_store_id": self.ks_id} if self.ks_id else None
        # Over-fetch ~4x; many patches collapse to one asset after dedupe.
        resp = self._s3v.query_vectors(
            vectorBucketName=self.bucket,
            indexName=self.index,
            topK=k * 4,
            queryVector={"float32": qvec},
            **({"filter": filt} if filt else {}),
            returnMetadata=True,
            returnDistance=True,
        )
        # score = 1 - cosine distance (higher = more similar)
        hits = []
        for v in resp.get("vectors", []):
            asset_id = (v.get("metadata") or {}).get("asset_id")
            if not asset_id:
                continue
            score = 1.0 - float(v.get("distance", 1.0))
            hits.append((asset_id, score))
        return dedupe_by_asset(hits)[:k]


PIPELINE = CurrentTitanPipeline()
