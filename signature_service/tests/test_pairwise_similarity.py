"""tasks.pairwise_similarity: every pair of signatures on one page, scored by the similarity model."""
from __future__ import annotations

import dataclasses
import random

from PIL import Image, ImageDraw

from app.config import settings
from app.inference import SignatureEmbedder
from app import tasks
from app.tasks import pairwise_similarity


def _page():
    """A page with the same signature twice (A at two places) and a different one (B)."""
    rng = random.Random(1)
    page = Image.new("RGB", (900, 400), "white")
    d = ImageDraw.Draw(page)
    sig_a = [(rng.randint(0, 200), rng.randint(0, 60)) for _ in range(12)]
    for ox, oy in ((40, 40), (500, 40)):
        d.line([(ox + x, oy + y) for x, y in sig_a], fill="navy", width=3)
    d.ellipse((300, 260, 420, 330), outline="black", width=4)
    d.line((290, 340, 440, 250), fill="black", width=4)
    return page


DETECTIONS = [  # sorted by score, like SignatureDetector.detect returns them
    {"label": "signature", "score": 0.9, "box_xyxy": [40.0, 40.0, 240.0, 100.0]},
    {"label": "signature", "score": 0.8, "box_xyxy": [500.0, 40.0, 700.0, 100.0]},
    {"label": "signature", "score": 0.7, "box_xyxy": [285.0, 245.0, 445.0, 345.0]},
]


def test_identical_signatures_are_the_closest_pair():
    out = pairwise_similarity(_page(), DETECTIONS, SignatureEmbedder(pretrained=False))
    assert out["available"] and out["compared"] == 3 and len(out["pairs"]) == 3
    best = out["pairs"][0]
    assert (best["a"], best["b"]) == (0, 1) and best["similarity"] > 0.999 and best["match"]
    assert out["threshold"] == settings.similarity_match_threshold   # no validated threshold on random weights
    assert out["note"].startswith("Baseline")


def test_only_the_top_signatures_are_compared(monkeypatch):
    monkeypatch.setattr(tasks, "settings", dataclasses.replace(settings, compare_max_signatures=2))
    out = pairwise_similarity(_page(), DETECTIONS, SignatureEmbedder(pretrained=False))
    assert out["compared"] == 2 and out["detected"] == 3 and [(p["a"], p["b"]) for p in out["pairs"]] == [(0, 1)]


def test_without_a_similarity_model(monkeypatch):
    monkeypatch.setattr(tasks, "settings", dataclasses.replace(settings, enable_similarity=False))
    out = pairwise_similarity(_page(), DETECTIONS, None)
    assert out == {"available": False, "reason": "similarity is disabled on this worker (ENABLE_SIMILARITY=false)"}


def test_embed_many_matches_single_embeddings():
    embedder = SignatureEmbedder(pretrained=False)
    crops = [_page().crop(tuple(int(v) for v in d["box_xyxy"])) for d in DETECTIONS]
    batch = embedder.embed_many(crops)
    for row, crop in zip(batch, crops):
        assert float((row - embedder.embed(crop)).abs().max()) < 1e-4
