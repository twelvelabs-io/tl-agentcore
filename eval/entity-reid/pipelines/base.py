"""Pipeline ABC. Each backend in pipelines/<name>.py exports a
PIPELINE = SomeSubclass(...) so bin/run_eval.py can load it by name."""

from __future__ import annotations

import abc


class Pipeline(abc.ABC):
    name: str

    @abc.abstractmethod
    def ingest(
        self,
        ks_id: str,
        max_assets: int | None = None,
        asset_ids: list[str] | None = None,
    ) -> None:
        """One-shot indexing. If `asset_ids` is given, index exactly that
        list (ignores `max_assets`). Otherwise iterate the whole KS up to
        `max_assets`. No-op for pipelines that share an already-populated
        index with production (e.g. current_titan)."""

    @abc.abstractmethod
    def query(self, query_image_bytes: bytes, k: int = 50) -> list[tuple[str, float]]:
        """Returns a ranked [(asset_id, score), ...]. Scores are
        pipeline-native (cosine, distance, similarity, …); only the
        ordering is compared across backends. Duplicate asset_ids are
        already deduped (the best score per asset is returned)."""


def dedupe_by_asset(hits: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """For pipelines that return multiple matches per asset (e.g.
    multiple patches per video), keep the best score per asset_id and
    re-sort. Caller decides whether higher or lower is better — this
    just compresses; ordering is preserved relative to the input."""
    best: dict[str, float] = {}
    first_index: dict[str, int] = {}
    for i, (a, s) in enumerate(hits):
        if a not in best:
            best[a] = s
            first_index[a] = i
        elif s > best[a]:
            best[a] = s
    return [(a, best[a]) for a in sorted(best, key=lambda x: first_index[x])]
