# entity-reID eval — `ks_demo01-trailers-hollywood`

17 queries, 4 pipelines.

## Aggregate

| pipeline | recall@1 | recall@5 | recall@10 | recall@20 | precision@5 | MRR | mAP | avg_latency_s |
|---|---|---|---|---|---|---|---|---|
| current_titan | 0.157 | 0.451 | 0.480 | 0.529 | 0.188 | 0.503 | 0.317 | 0.564 |
| rekognition_faces | 0.353 | 0.471 | 0.471 | 0.471 | 0.212 | 0.765 | 0.471 | 0.469 |
| nova_mm_embed | 0.029 | 0.088 | 0.176 | 0.206 | 0.035 | 0.122 | 0.073 | 0.535 |
| marengo_clips | 0.245 | 0.333 | 0.402 | 0.461 | 0.141 | 0.586 | 0.341 | 4.090 |

## Per-query

### q_jim_carrey — Jim Carrey — Rekognition Celebrity Detection (conf 99.9, source asset 346d916e)
_3 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.034 | 0.011 | `1f9d024d`, `2a18c732`, `0f6f17d9`, `2a9688dc`, `289d452b` |
| rekognition_faces | 0.667 | 0.667 | 1.000 | 0.667 | `02dc3440`★, `346d916e`★ |
| nova_mm_embed | 0.000 | 0.000 | 0.022 | 0.007 | `1056c852`, `08ef8c4b`, `2c95bc31`, `119d4990`, `191a5c2b` |
| marengo_clips | 0.333 | 0.667 | 1.000 | 0.417 | `346d916e`★, `06adfa44`, `d3f4e193`, `1f9d024d`, `87b953fc` |

### q_chris_evans — Chris Evans — Rekognition Celebrity Detection (conf 98.3, source asset 22c714d0)
_3 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.333 | 0.333 | 1.000 | 0.333 | `22c714d0`★, `1f59045b`, `289d452b`, `2c8945ca`, `3b985f7e` |
| rekognition_faces | 0.667 | 0.667 | 1.000 | 0.667 | `22c714d0`★, `1c8e0ea6`★ |
| nova_mm_embed | 0.000 | 0.000 | 0.023 | 0.008 | `2c95bc31`, `08ef8c4b`, `2789def7`, `122416e0`, `1056c852` |
| marengo_clips | 0.333 | 0.333 | 1.000 | 0.333 | `22c714d0`★, `deac25c2`, `d3570c0a`, `bfd782f0`, `10bd7b6a` |

### q_mark_wahlberg — Mark Wahlberg — Rekognition Celebrity Detection (conf 100.0, source asset 1f213302)
_3 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.333 | 0.667 | 1.000 | 0.390 | `1f213302`★, `191a5c2b`, `35c24a27`, `2e5e311e`, `0c4a902b` |
| rekognition_faces | 0.667 | 0.667 | 1.000 | 0.667 | `344b945a`★, `1f213302`★, `33c9b2a6` |
| nova_mm_embed | 0.000 | 0.000 | 0.045 | 0.039 | `2789def7`, `10eb04ef`, `195f900b`, `08ef8c4b`, `3b836148` |
| marengo_clips | 0.000 | 0.333 | 0.167 | 0.078 | `7d546f8e`, `97003abc`, `4408e418`, `c581e32d`, `b7643cdc` |

### q_pedro_pascal — Pedro Pascal — Rekognition Celebrity Detection (conf 100.0, source asset 00b6091b)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | `06adfa44`, `289d452b`, `2457fcf4`, `28d6caec`, `08ef8c4b` |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `00b6091b`★ |
| nova_mm_embed | 0.000 | 0.500 | 0.100 | 0.050 | `1a667637`, `1f9d024d`, `2457fcf4`, `39aedb71`, `1198b1f1` |
| marengo_clips | 0.500 | 0.500 | 0.500 | 0.250 | `87b953fc`, `00b6091b`★, `f0a6a080`, `5a19c3b5`, `649bb247` |

### q_russell_crowe — Russell Crowe — Rekognition Celebrity Detection (conf 100.0, source asset 04c54e5a)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.500 | 0.500 | 0.500 | 0.250 | `1f59045b`, `04c54e5a`★, `1f213302`, `289d452b`, `3986b6cc` |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `319a208f`★ |
| nova_mm_embed | 0.000 | 0.000 | 0.032 | 0.016 | `2789def7`, `191a5c2b`, `29151f92`, `2c166b67`, `18220d8e` |
| marengo_clips | 0.000 | 0.000 | 0.000 | 0.000 | `ec8a20cd`, `04150886`, `87b953fc`, `d6d1f406`, `1056c852` |

### q_amanda_seyfried — Amanda Seyfried — Rekognition Celebrity Detection (conf 100.0, source asset 04c54e5a)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 1.000 | 1.000 | 1.000 | 0.750 | `04c54e5a`★, `1ba72a33`, `0caa58dd`, `2c668af8`★, `0779bf66` |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `04c54e5a`★, `1f3519b4` |
| nova_mm_embed | 0.000 | 0.500 | 0.167 | 0.083 | `370bdf7d`, `2dd1dbab`, `11a0a084`, `283ed180`, `0779bf66` |
| marengo_clips | 0.500 | 0.500 | 1.000 | 0.500 | `04c54e5a`★, `adb84c89`, `c1c751d2`, `99d5a084`, `574b5aed` |

### q_jesse_eisenberg — Jesse Eisenberg — Rekognition Celebrity Detection (conf 100.0, source asset 323a11db)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.500 | 0.500 | 0.200 | 0.100 | `1efb3b96`, `289d452b`, `0966098b`, `0e346db1`, `323a11db`★ |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `05d22cbd`★ |
| nova_mm_embed | 0.000 | 0.000 | 0.000 | 0.000 | `1f3519b4`, `06cb4e72`, `2789def7`, `191a5c2b`, `3b836148` |
| marengo_clips | 0.500 | 0.500 | 1.000 | 0.500 | `323a11db`★, `9ce48749`, `e3b20b4d`, `3007c567`, `7811b058` |

### q_cameron_diaz — Cameron Diaz — Rekognition Celebrity Detection (conf 100.0, source asset 156a846c)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 1.000 | 1.000 | 0.500 | 0.500 | `0966098b`, `156a846c`★, `0e346db1`, `122c04aa`★, `38c823de` |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `122c04aa`★ |
| nova_mm_embed | 0.500 | 1.000 | 0.200 | 0.211 | `30ef1e67`, `0966098b`, `3986b6cc`, `1d7606d6`, `156a846c`★ |
| marengo_clips | 0.500 | 0.500 | 1.000 | 0.543 | `156a846c`★, `f2a25c6d`, `1198b1f1`, `0966098b`, `a48ddd0e` |

### q_guy_pearce — Guy Pearce — Rekognition Celebrity Detection (conf 100.0, source asset 13ae664e)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.500 | 0.500 | 1.000 | 0.525 | `13ae664e`★, `289d452b`, `156a846c`, `3b836148`, `15a8476c` |
| rekognition_faces | 1.000 | 1.000 | 1.000 | 1.000 | `319a208f`★, `13ae664e`★ |
| nova_mm_embed | 0.500 | 0.500 | 1.000 | 0.545 | `13ae664e`★, `18220d8e`, `1a667637`, `04cf163e`, `10eb04ef` |
| marengo_clips | 0.500 | 0.500 | 1.000 | 0.500 | `13ae664e`★, `c9a782c9`, `6ef368ea`, `aa387a35`, `1a667637` |

### q_dave_franco — Dave Franco — Rekognition Celebrity Detection (conf 100.0, source asset 323a11db)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.500 | 0.125 | 0.062 | `289d452b`, `31a8e8b0`, `1e2235ef`, `11a0a084`, `37bff014` |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| nova_mm_embed | 0.000 | 0.000 | 0.000 | 0.000 | `2789def7`, `1f3519b4`, `06cb4e72`, `04cf163e`, `1fd5789f` |
| marengo_clips | 0.000 | 0.000 | 0.026 | 0.013 | `9ce48749`, `7811b058`, `0b03a4be`, `dee85472`, `d0ccceb7` |

### q_lucy_liu — Lucy Liu — Rekognition Celebrity Detection (conf 100.0, source asset 1ea2e0d3)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.500 | 0.500 | 1.000 | 0.500 | `1ea2e0d3`★, `0de63135`, `1287cfe3`, `36f7df7e`, `2457fcf4` |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| nova_mm_embed | 0.000 | 0.000 | 0.000 | 0.000 | `122416e0`, `1a0f2388`, `283ed180`, `2dd1dbab`, `11a0a084` |
| marengo_clips | 0.000 | 0.500 | 0.143 | 0.071 | `df868fe9`, `782baa63`, `49d8cc85`, `f8e9ddb0`, `98aabe32` |

### q_ana_de_armas — Ana de Armas — Rekognition Celebrity Detection (conf 99.9, source asset 3612cb49)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | `28fca166`, `2d9feda1`, `18500ff0`, `0b03a4be`, `3b1ea783` |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | `2e5e311e` |
| nova_mm_embed | 0.000 | 0.000 | 0.020 | 0.010 | `370bdf7d`, `11a0a084`, `122416e0`, `0779bf66`, `2dd1dbab` |
| marengo_clips | 0.000 | 0.500 | 0.050 | 0.025 | `1ba72a33`, `db937656`, `a16674b6`, `b3ac91f8`, `9de8776f` |

### q_will_smith — Will Smith — Rekognition Celebrity Detection (conf 100.0, source asset 23fa4da7)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 1.000 | 1.000 | 1.000 | 1.000 | `23fa4da7`★, `252a1755`★, `1f59045b`, `37bff014`, `1f9d024d` |
| rekognition_faces | 1.000 | 1.000 | 1.000 | 1.000 | `23fa4da7`★, `252a1755`★ |
| nova_mm_embed | 0.000 | 0.500 | 0.056 | 0.071 | `346d916e`, `37bff014`, `1f9d024d`, `2457fcf4`, `252871e0` |
| marengo_clips | 1.000 | 1.000 | 1.000 | 1.000 | `23fa4da7`★, `252a1755`★, `55b37f0f`, `89941f44`, `9ac1d454` |

### q_hugh_jackman — Hugh Jackman — Rekognition Celebrity Detection (conf 99.9, source asset 2789def7)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.500 | 0.500 | 0.500 | 0.282 | `1f59045b`, `2789def7`★, `22c714d0`, `22741f32`, `23fa4da7` |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `2789def7`★ |
| nova_mm_embed | 0.500 | 0.500 | 0.333 | 0.167 | `18220d8e`, `191a5c2b`, `2789def7`★, `1056c852`, `08ef8c4b` |
| marengo_clips | 1.000 | 1.000 | 1.000 | 1.000 | `2789def7`★, `34907b78`★, `534cab4b`, `3b755a7f`, `51b90758` |

### q_emma_stone — Emma Stone — Rekognition Celebrity Detection (conf 100.0, source asset 29ce1b4f)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 1.000 | 1.000 | 0.500 | 0.500 | `0e346db1`, `3ae84b40`★, `0966098b`, `29ce1b4f`★, `28fca166` |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `3ae84b40`★ |
| nova_mm_embed | 0.000 | 0.000 | 0.040 | 0.020 | `0966098b`, `30ef1e67`, `2525771b`, `24d96152`, `12c1f82c` |
| marengo_clips | 0.000 | 0.000 | 0.026 | 0.013 | `d8bd1b6b`, `c1c751d2`, `813cb1b3`, `a48ddd0e`, `c9a782c9` |

### q_boyd_holbrook — Boyd Holbrook — Rekognition Celebrity Detection (conf 100.0, source asset 3b755a7f)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.000 | 0.000 | 0.000 | 0.000 | `289d452b`, `1f59045b`, `23fa4da7`, `00c681f5`, `1efb3b96` |
| rekognition_faces | 0.000 | 0.000 | 0.000 | 0.000 | (none) |
| nova_mm_embed | 0.000 | 0.000 | 0.000 | 0.000 | `2150f292`, `2789def7`, `191a5c2b`, `2c166b67`, `0caa58dd` |
| marengo_clips | 0.000 | 0.500 | 0.050 | 0.025 | `7811b058`, `1f9d024d`, `c79f79ba`, `87b953fc`, `5fe09f42` |

### q_lewis_tan — Lewis Tan — Rekognition Celebrity Detection (conf 100.0, source asset 30763497)
_2 ground-truth match(es)_

| pipeline | recall@5 | recall@20 | MRR | AP | top-5 |
|---|---|---|---|---|---|
| current_titan | 0.500 | 1.000 | 0.200 | 0.177 | `1f59045b`, `26be07a8`, `2c95bc31`, `25aa80ec`, `3b985f7e`★ |
| rekognition_faces | 0.500 | 0.500 | 1.000 | 0.500 | `3b985f7e`★ |
| nova_mm_embed | 0.000 | 0.000 | 0.029 | 0.014 | `1f3519b4`, `2789def7`, `191a5c2b`, `29151f92`, `08ef8c4b` |
| marengo_clips | 0.500 | 0.500 | 1.000 | 0.529 | `30763497`★, `7811b058`, `2c8945ca`, `8e290a41`, `79dcda53` |
