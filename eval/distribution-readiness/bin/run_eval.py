#!/usr/bin/env python3
"""Run the Distribution-readiness eval. Loads one or more brief JSON files,
invokes the agent locally for each, scores reference-free and (when
curated) reference-aware metrics, writes a timestamped JSON + Markdown
report.

Usage, from repo root with the agent venv active:

    python eval/distribution-readiness/bin/run_eval.py eval/distribution-readiness/briefs/01-sample.json

Or glob:

    python eval/distribution-readiness/bin/run_eval.py 'eval/distribution-readiness/briefs/*.json'

See `../README.md` for brief schema and metric definitions.
"""
from __future__ import annotations

import glob
import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from eval_harness import report as report_mod  # noqa: E402
from eval_harness import runner, scorer         # noqa: E402


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: run_eval.py <brief.json | glob> [...]", file=sys.stderr)
        return 2

    brief_paths: list[Path] = []
    for arg in argv:
        matches = glob.glob(arg)
        if not matches:
            print(f"no files matched: {arg}", file=sys.stderr)
        for m in matches:
            brief_paths.append(Path(m))

    if not brief_paths:
        print("no briefs to run.", file=sys.stderr)
        return 2

    bundles: list[dict] = []
    for p in brief_paths:
        print(f"→ running {p.name}", file=sys.stderr)
        try:
            brief = json.loads(p.read_text())
        except Exception as e:
            print(f"  skip {p.name}: {e}", file=sys.stderr)
            bundles.append({
                "id":     p.stem,
                "brief_path": str(p),
                "run":    {"error": f"load failed: {e}"},
                "scores": {"reference_free": {"card_present": False}, "reference_aware": {}},
            })
            continue

        try:
            run = runner.run_local(brief)
        except Exception as e:
            print(f"  run failed: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            run = {"error": f"{type(e).__name__}: {e}", "response_text": "", "elapsed_ms": 0}

        scores = scorer.score(brief, run)
        bundles.append({
            "id":         brief.get("id") or p.stem,
            "brief_path": str(p),
            "run":        run,
            "scores":     scores,
        })

    paths = report_mod.write(HERE / "reports", bundles)
    print(f"\nreport: {paths['md']}")
    print(f"json:   {paths['json']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
