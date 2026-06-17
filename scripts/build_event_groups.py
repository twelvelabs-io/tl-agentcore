#!/usr/bin/env python3
"""Cluster a knowledge store's assets into multi-clip events.

Phase 4 (offline event-grouping pipeline). Given the per-asset Pegasus
profiles and Marengo
visual embeddings, single-link-cluster assets that:

  * are visually similar (Marengo cosine ≥ threshold), and
  * share at least one mood tag or primary subject.

For each cluster of ≥ MIN_EVENT_SIZE assets, write an EVENT# record into
the existing kb_cache DDB table:

  pk = "ks#<ks_id>"  sk = "EVENT#<event_id>"
    {
      "description":         "<Bedrock-Claude one-liner summary>",
      "participating_assets": [asset_id, ...],
      "mood_signature":      [union of cluster mood_tags, sorted by freq],
      "primary_subjects":    [union of cluster primary_subjects],
      "cluster_size":        N,
      "confidence":          mean pairwise cosine,
      "created_at":          <unix-ts>
    }

Usage:
  export KB_CACHE_TABLE=$(terraform -chdir=infra output -raw kb_cache_table)
  export VECTOR_BUCKET_NAME=$(terraform -chdir=infra output -raw vector_bucket_name)
  AWS_PROFILE=... python3 scripts/build_event_groups.py ks_<id> \\
      [--threshold 0.7] [--min-size 2]

Idempotent: pre-existing EVENT# records under the same pk are deleted
before writing the new clusters, so re-running reflects the latest
profile + embedding state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
import uuid
from collections import Counter
from typing import Any

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
KB_CACHE_TABLE = os.environ.get("KB_CACHE_TABLE")
VECTOR_BUCKET = os.environ.get("VECTOR_BUCKET_NAME")
VECTOR_INDEX_VISUAL = os.environ.get("VECTOR_INDEX_VISUAL", "asset-embeddings-visual")
# Backward-compat: single-index layout
VECTOR_INDEX_NAME = os.environ.get("VECTOR_INDEX_NAME")
BEDROCK_MODEL = os.environ.get("EVENT_SUMMARY_MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")

if not KB_CACHE_TABLE or not VECTOR_BUCKET:
    print("error: KB_CACHE_TABLE + VECTOR_BUCKET_NAME env vars required", file=sys.stderr)
    sys.exit(2)

ddb = boto3.client("dynamodb", region_name=REGION)
s3v = boto3.client("s3vectors", region_name=REGION)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)


# ─── DDB ↔ Python helpers (kept inline to avoid pulling a separate module) ──
def _from_ddb(v):
    if "S" in v: return v["S"]
    if "N" in v: return float(v["N"]) if "." in v["N"] else int(v["N"])
    if "BOOL" in v: return v["BOOL"]
    if "L" in v: return [_from_ddb(x) for x in v["L"]]
    if "M" in v: return {k: _from_ddb(x) for k, x in v["M"].items()}
    if "NULL" in v: return None
    return None


def _to_ddb(value):
    if value is None:
        return {"NULL": True}
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        return {"L": [_to_ddb(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: _to_ddb(v) for k, v in value.items()}}
    return {"S": str(value)}


def _query_profiles(ks_id: str) -> list[dict]:
    out: list[dict] = []
    page = None
    while True:
        kwargs = {
            "TableName": KB_CACHE_TABLE,
            "KeyConditionExpression": "pk = :p AND begins_with(sk, :s)",
            "ExpressionAttributeValues": {":p": {"S": f"ks#{ks_id}"}, ":s": {"S": "ASSET#"}},
        }
        if page:
            kwargs["ExclusiveStartKey"] = page
        r = ddb.query(**kwargs)
        for it in r.get("Items", []):
            out.append({k: _from_ddb(v) for k, v in it.items()})
        page = r.get("LastEvaluatedKey")
        if not page:
            break
    return out


def _delete_existing_events(ks_id: str) -> int:
    """Idempotency: drop any prior EVENT# records before writing the new
    set. Avoids stale clusters lingering after a re-run with different
    profiles."""
    deleted = 0
    page = None
    while True:
        kwargs = {
            "TableName": KB_CACHE_TABLE,
            "KeyConditionExpression": "pk = :p AND begins_with(sk, :s)",
            "ExpressionAttributeValues": {":p": {"S": f"ks#{ks_id}"}, ":s": {"S": "EVENT#"}},
            "ProjectionExpression": "pk, sk",
        }
        if page:
            kwargs["ExclusiveStartKey"] = page
        r = ddb.query(**kwargs)
        for it in r.get("Items", []):
            ddb.delete_item(
                TableName=KB_CACHE_TABLE,
                Key={"pk": it["pk"], "sk": it["sk"]},
            )
            deleted += 1
        page = r.get("LastEvaluatedKey")
        if not page:
            break
    return deleted


# ─── Per-asset visual embedding (mean-pool of all clip segments) ────────────
def _mean_visual_embedding(ks_id: str, asset_id: str) -> list[float] | None:
    """Pull every visual-modality embedding for `asset_id` from S3 Vectors
    (filtered by knowledge_store_id when the indexing pipeline writes that
    metadata; falls back to global asset_id filter otherwise) and
    L2-normalize the mean. Returns None if no embeddings exist for the
    asset — caller should skip clustering it."""
    index_name = VECTOR_INDEX_VISUAL if not VECTOR_INDEX_NAME else VECTOR_INDEX_NAME

    # S3 Vectors doesn't support a "list by metadata" — it's an ANN store.
    # Trick: query with a zero vector and a high topK; filter by asset_id
    # in the metadata filter. Not the most elegant, but the S3 Vectors
    # API doesn't expose a list operation, so this is the path of least
    # resistance for the offline pipeline.
    filt = {"asset_id": asset_id}
    try:
        # S3 Vectors caps topK at 100 per query. For most assets that's
        # plenty of clip-segments; very long videos would need pagination
        # via repeated queries with different filters (out of scope here).
        # Query vector must be valid (non-zero, finite) — S3 Vectors rejects
        # all-zero vectors. Use a normalized unit vector since we only care
        # about the metadata filter, not ranking.
        unit_val = 1.0 / math.sqrt(512)
        resp = s3v.query_vectors(
            vectorBucketName=VECTOR_BUCKET,
            indexName=index_name,
            topK=100,
            queryVector={"float32": [unit_val] * 512},
            filter=filt,
            returnMetadata=True,
            returnDistance=False,
        )
    except Exception as e:
        print(f"  ⚠ s3vectors query failed for {asset_id[:12]}: {e}", file=sys.stderr)
        return None

    rows = resp.get("vectors") or []
    if not rows:
        return None

    # S3 Vectors only returns the vector data when explicitly requested via
    # GetVectors; query_vectors returns distance + metadata. To get the
    # raw vector bytes for averaging we'd need a separate GetVectors call.
    # For a simple representative-vector path we just take the first
    # matching key and GetVectors on it. (Mean-pool would be ideal — left
    # as a TODO when we have GetVectors batching in our IAM policy.)
    keys = [v.get("key") for v in rows if v.get("key")]
    if not keys:
        return None
    try:
        got = s3v.get_vectors(
            vectorBucketName=VECTOR_BUCKET,
            indexName=index_name,
            keys=keys[:32],  # cap for the mean-pool
            returnData=True,
        )
    except Exception as e:
        print(f"  ⚠ s3vectors get_vectors failed for {asset_id[:12]}: {e}", file=sys.stderr)
        return None

    vecs = [v.get("data", {}).get("float32") for v in got.get("vectors") or []]
    vecs = [v for v in vecs if v]
    if not vecs:
        return None

    # Mean-pool then L2-normalize.
    dim = len(vecs[0])
    mean = [0.0] * dim
    for v in vecs:
        for i, x in enumerate(v):
            mean[i] += x
    n = float(len(vecs))
    mean = [x / n for x in mean]
    norm = math.sqrt(sum(x * x for x in mean)) or 1.0
    return [x / norm for x in mean]


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ─── Single-link clustering on (cosine + tag-overlap) ───────────────────────
def _cluster(
    asset_profiles: list[dict],
    asset_vectors: dict[str, list[float]],
    *,
    cosine_threshold: float,
) -> list[list[dict]]:
    """Union-find single-link clustering. Two assets link if their visual
    embeddings cosine ≥ threshold AND they share ≥ 1 mood_tag or
    primary_subject. The tag-overlap requirement keeps unrelated
    visually-similar clips (e.g. two unrelated nature shots) from getting
    grouped just because both are 'cinematic + golden hour'."""
    n = len(asset_profiles)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    for i in range(n):
        ai = asset_profiles[i]
        vi = asset_vectors.get(ai["asset_id"])
        if vi is None:
            continue
        moods_i = set(t.lower() for t in (ai.get("mood_tags") or []))
        subj_i = set(s.lower() for s in (ai.get("primary_subjects") or []))
        for j in range(i + 1, n):
            aj = asset_profiles[j]
            vj = asset_vectors.get(aj["asset_id"])
            if vj is None:
                continue
            cos = _cosine(vi, vj)
            if cos < cosine_threshold:
                continue
            moods_j = set(t.lower() for t in (aj.get("mood_tags") or []))
            subj_j = set(s.lower() for s in (aj.get("primary_subjects") or []))
            if not (moods_i & moods_j) and not (subj_i & subj_j):
                continue
            union(i, j)

    by_root: dict[int, list[dict]] = {}
    for i in range(n):
        if asset_vectors.get(asset_profiles[i]["asset_id"]) is None:
            continue
        by_root.setdefault(find(i), []).append(asset_profiles[i])
    return list(by_root.values())


def _cluster_confidence(cluster: list[dict], asset_vectors: dict[str, list[float]]) -> float:
    """Mean pairwise cosine within a cluster. ~1 = tight cluster."""
    vs = [asset_vectors[a["asset_id"]] for a in cluster if a["asset_id"] in asset_vectors]
    if len(vs) < 2:
        return 1.0
    pairs = 0
    total = 0.0
    for i in range(len(vs)):
        for j in range(i + 1, len(vs)):
            total += _cosine(vs[i], vs[j])
            pairs += 1
    return total / max(1, pairs)


# ─── Bedrock Claude summary per cluster ─────────────────────────────────────
def _summarize_cluster(cluster: list[dict]) -> str:
    """One-line Claude summary of what the clustered clips collectively
    depict. Compact prompt; deterministic temperature."""
    bullets = []
    for a in cluster:
        title = a.get("title") or "untitled"
        liner = a.get("one_liner") or ""
        bullets.append(f"- {title}: {liner}")
    prompt = (
        "Below are N short video clips that were grouped together because "
        "they look similar AND share mood/subject tags. Write ONE sentence "
        "(20 words or fewer) describing what they collectively show as "
        "a single multi-clip event — not a list, not a summary of each. "
        "Plain prose. No quotes or formatting:\n\n" + "\n".join(bullets)
    )
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 100,
        "temperature": 0.2,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
    }
    try:
        r = bedrock.invoke_model(
            modelId=BEDROCK_MODEL,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        payload = json.loads(r["body"].read())
        return payload.get("content", [{}])[0].get("text", "").strip()
    except Exception as e:
        return f"({len(cluster)} clips; summary unavailable: {e})"


# ─── Write EVENT# records ───────────────────────────────────────────────────
def _event_id(ks_id: str, cluster: list[dict]) -> str:
    """Stable id derived from sorted participating asset_ids — re-running
    with the same cluster membership produces the same EVENT# key."""
    ids = sorted(a["asset_id"] for a in cluster)
    h = hashlib.sha1("|".join(ids).encode()).hexdigest()[:12]
    return f"evt_{h}"


def _write_event(ks_id: str, cluster: list[dict], asset_vectors, description: str) -> dict:
    eid = _event_id(ks_id, cluster)

    mood_counts: Counter[str] = Counter()
    subjects: set[str] = set()
    for a in cluster:
        for m in (a.get("mood_tags") or []):
            if isinstance(m, str):
                mood_counts[m.lower()] += 1
        for s in (a.get("primary_subjects") or []):
            if isinstance(s, str):
                subjects.add(s.lower())

    record = {
        "event_id":             eid,
        "description":          description,
        "participating_assets": [a["asset_id"] for a in cluster],
        "mood_signature":       [m for m, _ in mood_counts.most_common(8)],
        "primary_subjects":     sorted(subjects),
        "cluster_size":         len(cluster),
        "confidence":           round(_cluster_confidence(cluster, asset_vectors), 4),
        "created_at":           int(time.time()),
    }

    item = {
        "pk": {"S": f"ks#{ks_id}"},
        "sk": {"S": f"EVENT#{eid}"},
        **{k: _to_ddb(v) for k, v in record.items()},
    }
    ddb.put_item(TableName=KB_CACHE_TABLE, Item=item)
    return record


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("ks_id", help="Knowledge store id (form: ks_xxxxxxxx)")
    ap.add_argument("--threshold", type=float, default=0.7,
                    help="Cosine similarity floor for the linkage step (default 0.7).")
    ap.add_argument("--min-size", type=int, default=2,
                    help="Minimum cluster size to write as an event (default 2).")
    args = ap.parse_args()

    print(f"→ reading kb_cache asset profiles for {args.ks_id}")
    profiles = _query_profiles(args.ks_id)
    print(f"  {len(profiles)} assets")
    if not profiles:
        print("  no profiles to cluster")
        return 0

    print(f"→ fetching visual embeddings (one representative vector per asset)")
    asset_vectors: dict[str, list[float]] = {}
    for p in profiles:
        aid = p.get("asset_id")
        if not aid:
            continue
        vec = _mean_visual_embedding(args.ks_id, aid)
        if vec:
            asset_vectors[aid] = vec
            print(f"  ✓ {aid[:12]}  dim={len(vec)}")
        else:
            print(f"  ✗ {aid[:12]}  (no embedding)")

    print(f"→ deleting any pre-existing EVENT# records under ks#{args.ks_id}")
    n_del = _delete_existing_events(args.ks_id)
    print(f"  removed {n_del}")

    print(f"→ clustering (cosine ≥ {args.threshold}, mood/subject overlap required)")
    clusters = _cluster(profiles, asset_vectors, cosine_threshold=args.threshold)
    big_clusters = [c for c in clusters if len(c) >= args.min_size]
    print(f"  {len(clusters)} clusters total · {len(big_clusters)} pass min-size {args.min_size}")

    if not big_clusters:
        print("→ no multi-clip events found at the current thresholds — done")
        return 0

    print(f"→ writing {len(big_clusters)} events")
    for cluster in big_clusters:
        desc = _summarize_cluster(cluster)
        rec = _write_event(args.ks_id, cluster, asset_vectors, desc)
        print(
            f"  ✓ {rec['event_id']}  size={rec['cluster_size']}  "
            f"conf={rec['confidence']:.3f}  '{rec['description'][:80]}'"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
