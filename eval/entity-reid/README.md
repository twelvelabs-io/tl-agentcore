# entity-reID quality eval

Compares "find clips with this person / face" pipelines against a held-out
ground-truth labeling on real KS footage. The output is a side-by-side
table of recall@K, precision@K, MRR, and mAP — the artifact we need to
choose a Phase 3 architecture on quality grounds instead of vibes.

Currently scaffolds three pipelines:

| Name | Index path | Query path |
|---|---|---|
| `current_titan` | gdino + DeepSORT + TAO + Titan → S3 Vectors `entity-patches` | Titan embed query → `QueryVectors` |
| `rekognition_faces` | `IndexFaces` per sampled frame into a Rekognition collection | `SearchFacesByImage` |
| `nova_mm_embed` | Nova MM Embed (`GENERIC_INDEX`) per sampled frame → new S3 Vectors index | Nova MM Embed (`IMAGE_RETRIEVAL`) → `QueryVectors` |

Each lives in `pipelines/`. Add another by subclassing `Pipeline` in
`pipelines/base.py`.

## Workflow

```bash
# 0. install deps
python -m venv .venv && . .venv/bin/activate
pip install -r eval/entity-reid/requirements.txt

# 1. drop query thumbnails into queries/ (jpg or png), then label them.
#    `label.py` walks the KS asset table and prompts y/n per asset.
python eval/entity-reid/bin/label.py \
  --ks ks_<id> \
  --query eval/entity-reid/queries/01_jane.jpg \
  --out eval/entity-reid/ground_truth.yaml

# 2. ingest the non-Titan pipelines (Titan already populated by the
#    production entity_reid Step Function; nothing to do for that one).
python eval/entity-reid/bin/ingest.py \
  --pipeline rekognition_faces \
  --ks ks_<id>

python eval/entity-reid/bin/ingest.py \
  --pipeline nova_mm_embed \
  --ks ks_<id>

# 3. run the eval. Prints a markdown report to stdout + writes a copy
#    under results/.
python eval/entity-reid/bin/run_eval.py \
  --gt eval/entity-reid/ground_truth.yaml \
  --pipelines current_titan,rekognition_faces,nova_mm_embed
```

## Ground-truth schema

See `ground_truth.example.yaml`. Per query: a label, a path to the
query thumbnail, and the list of `asset_id`s in the KS that contain the
target. 15–25 queries is enough; mix clear frontal headshots with
profile, occluded, low-res, and ensemble-scene queries.

## Metrics

- **recall@K** = `|relevant ∩ top-K| / |relevant|`. Plot at K = 1, 5, 10, 20.
- **precision@K** = `|relevant ∩ top-K| / K`.
- **MRR** = mean reciprocal rank of the first true positive.
- **mAP** = mean average precision across queries.

`metrics.py` is pure-Python — no sklearn dependency. Read it if a number
looks off; it's ~80 lines.

## What this eval can and can't tell you

**Can:** which pipeline ranks the correct clips highest on this corpus
for this query distribution. Failure-mode patterns (e.g. "Rekognition
misses profile shots", "Titan over-fires on the background").

**Can't:** generalize to a different content type without re-labeling.
A sports KS will have very different signal/noise than a film-dailies
KS. Re-run the eval per content category if quality matters across
them.
