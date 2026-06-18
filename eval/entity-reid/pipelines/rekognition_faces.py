"""Rekognition Faces pipeline. Sampled frames per asset are IndexFaces'd
into a managed Rekognition collection at ingest. Query is one
SearchFacesByImage call. ExternalImageId carries the asset_id so we
can group hits back.

Env vars:
  AWS_REGION                 default us-east-1
  REK_COLLECTION_ID          collection name (eval/entity-reid creates it on ingest)
  CLIPS_BUCKET_NAME          where MediaConvert frame captures live
  ASSETS_TABLE               DDB table — used to enumerate KS assets at ingest
  FRAMES_PER_ASSET           how many frames to sample (default 5)
  MATCH_THRESHOLD            SearchFacesByImage FaceMatchThreshold (default 80.0)
"""

from __future__ import annotations

import os
from typing import Iterable

import boto3
from botocore.exceptions import ClientError

from .base import Pipeline, dedupe_by_asset


class RekognitionFacesPipeline(Pipeline):
    name = "rekognition_faces"

    def __init__(
        self,
        collection_id: str | None = None,
        region: str | None = None,
    ):
        self.region = region or os.environ.get("AWS_REGION", "us-east-1")
        self.collection_id = collection_id or os.environ.get("REK_COLLECTION_ID", "tl-agentcore-eval-faces")
        self.clips_bucket = os.environ.get("CLIPS_BUCKET_NAME")
        self.assets_table = os.environ.get("ASSETS_TABLE")
        self.frames_per_asset = int(os.environ.get("FRAMES_PER_ASSET", "5"))
        self.match_threshold = float(os.environ.get("MATCH_THRESHOLD", "80.0"))
        self._rek = boto3.client("rekognition", region_name=self.region)
        self._s3 = boto3.client("s3", region_name=self.region)
        self._ddb = boto3.client("dynamodb", region_name=self.region)

    def _ensure_collection(self) -> None:
        try:
            self._rek.create_collection(CollectionId=self.collection_id)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceAlreadyExistsException":
                raise

    def _iter_assets(self, ks_id: str) -> Iterable[str]:
        """Yield asset_ids in ks_id from the by-ks GSI."""
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
        """List the MediaConvert frame captures for an asset, sample
        evenly across the timeline up to frames_per_asset."""
        prefix = f"frames/{asset_id}/"
        resp = self._s3.list_objects_v2(Bucket=self.clips_bucket, Prefix=prefix)
        keys = sorted(o["Key"] for o in resp.get("Contents", []) if o["Key"].lower().endswith((".jpg", ".jpeg", ".png")))
        if len(keys) <= self.frames_per_asset:
            return keys
        # Even spacing across the timeline.
        step = len(keys) / self.frames_per_asset
        return [keys[int(i * step)] for i in range(self.frames_per_asset)]

    def ingest(self, ks_id: str, max_assets: int | None = None) -> None:
        if not (self.clips_bucket and self.assets_table):
            raise RuntimeError("CLIPS_BUCKET_NAME + ASSETS_TABLE env vars are required")
        self._ensure_collection()
        n_assets = 0
        for asset_id in self._iter_assets(ks_id):
            if max_assets is not None and n_assets >= max_assets:
                break
            keys = self._frame_keys(asset_id)
            for key in keys:
                try:
                    self._rek.index_faces(
                        CollectionId=self.collection_id,
                        Image={"S3Object": {"Bucket": self.clips_bucket, "Name": key}},
                        ExternalImageId=asset_id,
                        DetectionAttributes=["DEFAULT"],
                        MaxFaces=10,
                        QualityFilter="AUTO",
                    )
                except ClientError as e:
                    print(f"  ! IndexFaces({asset_id} / {key}): {e.response['Error']['Code']}")
            n_assets += 1
            if n_assets % 25 == 0:
                print(f"  · {n_assets} assets indexed")
        print(f"  ✓ {n_assets} assets indexed into {self.collection_id}")

    def query(self, query_image_bytes: bytes, k: int = 50) -> list[tuple[str, float]]:
        try:
            resp = self._rek.search_faces_by_image(
                CollectionId=self.collection_id,
                Image={"Bytes": query_image_bytes},
                FaceMatchThreshold=self.match_threshold,
                MaxFaces=k * 4,
                QualityFilter="AUTO",
            )
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code == "InvalidParameterException":
                # No face detected in the query.
                return []
            raise
        hits = []
        for m in resp.get("FaceMatches", []):
            ext = m.get("Face", {}).get("ExternalImageId")
            if not ext:
                continue
            # Rekognition returns Similarity as 0-100. Normalize to 0-1.
            hits.append((ext, float(m["Similarity"]) / 100.0))
        return dedupe_by_asset(hits)[:k]


PIPELINE = RekognitionFacesPipeline()
