# Whitepaper diagrams

Four flowcharts referenced from `docs/whitepaper.md`. Reviewers on the Google Doc see raw mermaid text instead of rendered diagrams (mermaid doesn't render natively in Docs), so each block is also published as a PNG that can be pasted into the Doc.

## Files

- `component-map.mmd` — §3.1 component map (Browser → CloudFront → Chat λ → AgentCore Runtime → Marengo / S3 Vectors / Pegasus / Clips bucket).
- `parallel-retrieval.mmd` — §3.2 retrieval fan-out (one `vector_search` per beat, in parallel, returning the EDL in one turn).
- `conversation-mode.mmd` — §3.3 follow-up classifier (informational → `pegasus_analyze`; structural → `vector_search`; ambiguous → clarifying question).
- `ingest-pipeline.mmd` — §4.3 ingest pipeline (script → S3 mirror → Marengo async invoke → S3 Vectors `PutVectors`).

## Rendering to PNG

The PNGs that get pasted into the Google Doc are named `tl-agentcore-<diagram>.png` and were rendered via [Kroki](https://kroki.io)'s mermaid endpoint. To regenerate them:

```bash
# Open the renderer in any browser and click "Download PNG" on each card:
open docs/diagrams/whitepaper-diagrams.html

# Or via the Kroki CLI (with mermaid-cli installed):
mmdc -i component-map.mmd -o component-map.png -b white -s 2
```

The `.mmd` files are the source of truth; PNGs are rebuilt from them.
