from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from parliament.blackboard import Turn

_model = None


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def compute_osi(turns: list[Turn], min_pairs: int = 2) -> float | None:
    """Return mean cosine similarity between consecutive same-agent turns, or None if insufficient data."""
    by_agent: dict[str, list[str]] = defaultdict(list)
    for t in turns:
        by_agent[t["agent"]].append(t["content"])

    # Only agents with >= 2 turns contribute
    eligible = {agent: texts for agent, texts in by_agent.items() if len(texts) >= 2}
    if not eligible:
        return None

    model = _get_model()
    similarities: list[float] = []
    for texts in eligible.values():
        embeddings = model.encode(texts)
        for i in range(len(embeddings) - 1):
            similarities.append(_cosine(embeddings[i], embeddings[i + 1]))

    if len(similarities) < min_pairs:
        return None

    return float(np.mean(similarities))
