# entity-reID eval — `ks_demo01-trailers-hollywood`

5 queries, 3 pipelines.

## Aggregate

| pipeline | recall@1 | recall@5 | recall@10 | recall@20 | precision@5 | MRR | mAP | avg_latency_s |
|---|---|---|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.810 |
| rekognition_faces | 0.200 | 0.200 | 0.200 | 0.200 | 0.040 | 0.200 | 0.200 | 0.644 |
| nova_mm_embed | 0.600 | 1.000 | 1.000 | 1.000 | 0.200 | 0.740 | 0.740 | 0.839 |

## Per-query

### q_bc9525a3 — self-retrieval: 12_Years_a_Slave__76203.mp4 — frame #20 query, indexed frames 0/5/10/15
_1 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| nova_mm_embed | 1.000 | 1.000 | 1.000 | 1.000 | `bc9525a3`★, `2087596e`, `c2d61d34`, `d53732f3`, `e699cdc0` |

### q_d53732f3 — self-retrieval: 101_Dalmatians__11674.mp4 — frame #20 query, indexed frames 0/5/10/15
_1 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| nova_mm_embed | 1.000 | 1.000 | 0.200 | 0.200 | `2087596e`, `bc9525a3`, `c2d61d34`, `e699cdc0`, `d53732f3`★ |

### q_c2d61d34 — self-retrieval: 17_Again__16996.mp4 — frame #20 query, indexed frames 0/5/10/15
_1 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| rekognition_faces | 1.000 | 1.000 | 1.000 | 1.000 | `c2d61d34`★ |
| nova_mm_embed | 1.000 | 1.000 | 0.500 | 0.500 | `bc9525a3`, `c2d61d34`★, `e699cdc0`, `2087596e`, `d53732f3` |

### q_2087596e — self-retrieval: 10_Cloverfield_Lane__333371.mp4 — frame #20 query, indexed frames 0/5/10/15
_1 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| nova_mm_embed | 1.000 | 1.000 | 1.000 | 1.000 | `2087596e`★, `c2d61d34`, `d53732f3`, `bc9525a3`, `e699cdc0` |

### q_e699cdc0 — self-retrieval: 13_Going_on_30__10096.mp4 — frame #20 query, indexed frames 0/5/10/15
_1 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| nova_mm_embed | 1.000 | 1.000 | 1.000 | 1.000 | `e699cdc0`★, `c2d61d34`, `bc9525a3`, `d53732f3`, `2087596e` |
