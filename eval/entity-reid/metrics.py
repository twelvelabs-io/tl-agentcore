"""Retrieval-quality metrics. Pure-Python, no sklearn."""

from __future__ import annotations


def recall_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    if not relevant:
        return float("nan")  # negative-control query — recall is undefined
    hits = sum(1 for a in ranked[:k] if a in relevant)
    return hits / len(relevant)


def precision_at_k(ranked: list[str], relevant: set[str], k: int) -> float:
    if k == 0:
        return 0.0
    hits = sum(1 for a in ranked[:k] if a in relevant)
    return hits / k


def reciprocal_rank(ranked: list[str], relevant: set[str]) -> float:
    """1 / rank of first true positive, or 0 if none in the list."""
    for i, a in enumerate(ranked, start=1):
        if a in relevant:
            return 1.0 / i
    return 0.0


def average_precision(ranked: list[str], relevant: set[str]) -> float:
    """Standard AP: mean of precision@K over the ranks of true positives."""
    if not relevant:
        return float("nan")
    hits = 0
    total = 0.0
    for i, a in enumerate(ranked, start=1):
        if a in relevant:
            hits += 1
            total += hits / i
    return total / len(relevant) if hits else 0.0


def summarize(
    per_query: list[dict],
    ks: tuple[int, ...] = (1, 5, 10, 20),
) -> dict:
    """Aggregate per-query results into mean metrics. NaN-safe."""

    def mean(xs: list[float]) -> float:
        xs = [x for x in xs if not _isnan(x)]
        return sum(xs) / len(xs) if xs else float("nan")

    return {
        **{f"recall@{k}": mean([q[f"recall@{k}"] for q in per_query]) for k in ks},
        **{f"precision@{k}": mean([q[f"precision@{k}"] for q in per_query]) for k in ks},
        "MRR": mean([q["RR"] for q in per_query]),
        "mAP": mean([q["AP"] for q in per_query]),
    }


def score_query(
    ranked: list[str],
    relevant: set[str],
    ks: tuple[int, ...] = (1, 5, 10, 20),
) -> dict:
    return {
        **{f"recall@{k}": recall_at_k(ranked, relevant, k) for k in ks},
        **{f"precision@{k}": precision_at_k(ranked, relevant, k) for k in ks},
        "RR": reciprocal_rank(ranked, relevant),
        "AP": average_precision(ranked, relevant),
    }


def _isnan(x: float) -> bool:
    return x != x
