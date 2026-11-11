"""End-to-end: real Redis + real Celery worker process + FastAPI + S3 registry (moto server).

Covers: async/sync jobs, validation errors, upload clean-up, similarity, model info /
cold start, and hot reload when the S3 alias moves to a new version (auto-deploy path).
"""
import os
import shutil
import subprocess
import sys
import time

import boto3
import pytest
from fastapi.testclient import TestClient

from tests.conftest import E2E_BUCKET, E2E_PREFIX, MOTO_PORT, REDIS_PORT, ROOT, TMP
from tests.helpers import document_png, publish_similarity_version, publish_version

# Locally a missing redis-server only skips these tests. In CI (CI=true) it must not: a silent skip would hide that
# the end-to-end tests did not run at all, so there the stack fixture fails loudly instead.
pytestmark = pytest.mark.skipif(shutil.which("redis-server") is None and not os.environ.get("CI"),
                                reason="redis-server not installed")


@pytest.fixture(scope="module")
def stack():
    from moto.server import ThreadedMotoServer

    redis = subprocess.Popen(["redis-server", "--port", str(REDIS_PORT), "--save", "", "--appendonly", "no"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    moto = ThreadedMotoServer(ip_address="127.0.0.1", port=MOTO_PORT)
    moto.start()
    s3 = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{MOTO_PORT}", region_name="us-east-1")
    s3.create_bucket(Bucket=E2E_BUCKET)
    publish_version(s3, E2E_BUCKET, E2E_PREFIX, "v1", TMP / "publish", seed=1)
    publish_similarity_version(s3, E2E_BUCKET, "signatureai/similarity", "s1", TMP / "publish",
                               threshold=0.81, seed=1)

    worker_env = {**os.environ, "AWS_ENDPOINT_URL": f"http://127.0.0.1:{MOTO_PORT}"}
    log_path = TMP / "worker.log"
    worker = subprocess.Popen(
        [sys.executable, "-m", "celery", "-A", "app.celery_app:celery_app", "worker", "-Q", "inference",
         "--concurrency=1", "--loglevel=INFO", "-n", "e2e@%h"],
        cwd=ROOT, env=worker_env, stdout=log_path.open("w"), stderr=subprocess.STDOUT)

    from app.api import app

    client = TestClient(app)
    deadline = time.time() + 180
    while time.time() < deadline:
        if worker.poll() is not None:
            raise RuntimeError("worker died:\n" + log_path.read_text()[-4000:])
        if client.get("/ready").status_code == 200:
            break
        time.sleep(1)
    else:
        raise RuntimeError("worker never became ready:\n" + log_path.read_text()[-4000:])

    yield {"client": client, "s3": s3, "log": log_path}

    worker.terminate()
    worker.wait(timeout=30)
    moto.stop()
    redis.terminate()


def _png(seed=0):
    return ("doc.png", document_png(seed), "image/png")


def test_health(stack):
    body = stack["client"].get("/health").json()
    assert body["status"] == "ok" and body["version"] == "dev"


def test_ready_reports_worker(stack):
    body = stack["client"].get("/ready").json()
    assert body == {"status": "ready", "workers": 1}


def test_detect_sync(stack):
    r = stack["client"].post("/v1/detect?wait=true&threshold=0.0", files={"file": _png()})
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    assert result["model_version"] == "v1"
    assert result["image_size"] == {"width": 900, "height": 600}
    assert result["signature_count"] == len(result["detections"]) > 0  # threshold 0 -> random model returns boxes
    first = result["detections"][0]
    assert set(first) == {"label", "score", "box_xyxy"} and first["label"] == "signature"
    x1, y1, x2, y2 = first["box_xyxy"]
    assert 0 <= x1 <= x2 <= 900 and 0 <= y1 <= y2 <= 600
    assert list((TMP / "uploads").iterdir()) == []  # upload deleted after processing


def test_detect_compares_every_pair_of_signatures(stack):
    r = stack["client"].post("/v1/detect?wait=true&threshold=0.0", files={"file": _png(2)})
    result = r.json()["result"]
    n = min(len(result["detections"]), 10)            # COMPARE_MAX_SIGNATURES default
    assert n >= 2, "the random test model should return several boxes at threshold 0"
    sim = result["similarity"]
    assert sim["available"] and sim["compared"] == n and len(sim["pairs"]) == n * (n - 1) // 2
    assert {(p["a"], p["b"]) for p in sim["pairs"]} == {(a, b) for a in range(n) for b in range(a + 1, n)}
    assert all(-1.0 <= p["similarity"] <= 1.0 and p["match"] == (p["similarity"] >= sim["threshold"]) for p in sim["pairs"])
    assert [p["similarity"] for p in sim["pairs"]] == sorted((p["similarity"] for p in sim["pairs"]), reverse=True)
    assert result["timings_ms"]["similarity"] is not None


def test_detect_without_compare(stack):
    r = stack["client"].post("/v1/detect?wait=true&threshold=0.0&compare=false", files={"file": _png(3)})
    result = r.json()["result"]
    assert result["similarity"] is None and result["timings_ms"]["similarity"] is None


def test_detect_async_then_poll(stack):
    client = stack["client"]
    r = client.post("/v1/detect", files={"file": _png(1)})
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    for _ in range(60):
        body = client.get(f"/v1/jobs/{job_id}").json()
        if body["status"] == "SUCCESS":
            break
        time.sleep(0.5)
    assert body["status"] == "SUCCESS"
    assert body["result"]["model_version"] == "v1"


def test_corrupt_image_is_422(stack):
    r = stack["client"].post("/v1/detect?wait=true", files={"file": ("x.png", b"not really a png", "image/png")})
    assert r.status_code == 422
    assert "InvalidImage" in r.json()["error"]


def test_wrong_content_type_is_415(stack):
    r = stack["client"].post("/v1/detect", files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 415


def test_verify_identical_vs_different(stack):
    client = stack["client"]
    same = client.post("/v1/verify?wait=true", files={"reference": _png(3), "candidate": _png(3)})
    assert same.status_code == 200, same.text
    same_result = same.json()["result"]
    assert same_result["similarity"] == pytest.approx(1.0, abs=1e-3)
    assert same_result["match"] is True
    diff = client.post("/v1/verify?wait=true", files={"reference": _png(3), "candidate": _png(9)})
    assert diff.json()["result"]["similarity"] < same_result["similarity"]


def test_model_info_has_cold_start(stack):
    r = stack["client"].get("/v1/model")
    assert r.status_code == 200
    info = r.json()["result"]
    assert info["detector_version"] == "v1"
    assert info["similarity_version"] == "s1"
    assert info["similarity_threshold"] == pytest.approx(0.81)
    assert info["cold_start_seconds"] > 0


def _poll(client, job_id, seconds=60):
    seen = []
    deadline = time.time() + seconds
    while time.time() < deadline:
        body = client.get(f"/v1/jobs/{job_id}").json()
        if not seen or seen[-1] != body["status"]:
            seen.append(body["status"])
        if body["status"] in {"SUCCESS", "FAILURE"}:
            return body, seen
        time.sleep(0.05)
    raise AssertionError(f"job did not finish, states seen: {seen}")


def test_queue_wait_is_reported(stack):
    r = stack["client"].post("/v1/detect?wait=true", files={"file": _png(4)})
    timings = r.json()["result"]["timings_ms"]
    assert timings["queue_wait"] is not None and timings["queue_wait"] >= 0
    assert r.json()["result"]["retries"] == 0


def test_transient_failure_is_retried_then_succeeds(stack):
    client = stack["client"]
    r = client.post("/v1/detect?simulate_failures=1", files={"file": _png(5)})
    assert r.status_code == 202
    body, seen = _poll(client, r.json()["job_id"])
    assert body["status"] == "SUCCESS", seen
    assert body["result"]["retries"] == 1
    assert list((TMP / "uploads").iterdir()) == []  # kept during retry, deleted when done


def test_retries_exhausted_ends_in_failure(stack):
    client = stack["client"]
    r = client.post("/v1/detect?simulate_failures=5", files={"file": _png(6)})  # MAX_RETRIES=2 in tests
    body, seen = _poll(client, r.json()["job_id"], seconds=90)
    assert body["status"] == "FAILURE"
    assert "TransientError" in body["error"]
    assert list((TMP / "uploads").iterdir()) == []


def test_simulation_rejected_when_disabled(stack, monkeypatch):
    import dataclasses

    import app.api as api

    monkeypatch.setattr(api, "settings", dataclasses.replace(api.settings, allow_failure_simulation=False))
    r = stack["client"].post("/v1/detect?simulate_failures=1", files={"file": _png(7)})
    assert r.status_code == 403


def test_hot_reload_when_alias_moves(stack):
    """Simulates the retraining pipeline: a new version is published and the alias moved."""
    client = stack["client"]
    publish_version(stack["s3"], E2E_BUCKET, E2E_PREFIX, "v2", TMP / "publish", seed=2)
    deadline = time.time() + 60
    version = None
    while time.time() < deadline:
        version = client.get("/v1/model").json()["result"]["detector_version"]
        if version == "v2":
            break
        time.sleep(1)
    assert version == "v2", stack["log"].read_text()[-3000:]
    r = client.post("/v1/detect?wait=true", files={"file": _png()})
    assert r.json()["result"]["model_version"] == "v2"


def test_similarity_hot_reload_when_alias_moves(stack):
    """A validated Siamese alias version is loaded and atomically replaces the old embedder."""
    client = stack["client"]
    publish_similarity_version(stack["s3"], E2E_BUCKET, "signatureai/similarity", "s2", TMP / "publish",
                               threshold=0.91, seed=2)
    deadline = time.time() + 60
    info = None
    while time.time() < deadline:
        info = client.get("/v1/model").json()["result"]
        if info["similarity_version"] == "s2":
            break
        time.sleep(1)
    assert info["similarity_version"] == "s2", stack["log"].read_text()[-3000:]
    assert info["similarity_threshold"] == pytest.approx(0.91)
    assert info["last_similarity_reload_error"] is None
    result = client.post("/v1/verify?wait=true", files={"reference": _png(3), "candidate": _png(3)}).json()["result"]
    assert result["similarity_version"] == "s2"
    assert result["threshold"] == pytest.approx(0.91)


def _wait_for_model_info(client, predicate, seconds):
    deadline, info = time.time() + seconds, None
    while time.time() < deadline:
        info = client.get("/v1/model").json()["result"]
        if predicate(info):
            break
        time.sleep(1)
    return info


def test_broken_similarity_alias_keeps_serving_previous_model(stack):
    """Self-contained: it first publishes and waits for its own good release, so test order does not matter."""
    client, s3 = stack["client"], stack["s3"]
    publish_similarity_version(s3, E2E_BUCKET, "signatureai/similarity", "s-good", TMP / "publish", threshold=0.88, seed=4)
    info = _wait_for_model_info(client, lambda i: i["similarity_version"] == "s-good", 60)
    assert info["similarity_version"] == "s-good", stack["log"].read_text()[-3000:]

    publish_similarity_version(s3, E2E_BUCKET, "signatureai/similarity", "s-broken", TMP / "publish",
                               threshold=0.92, seed=3, tamper=True)
    info = _wait_for_model_info(client, lambda i: i["last_similarity_reload_error"], 30)
    assert "SHA-256" in (info["last_similarity_reload_error"] or ""), stack["log"].read_text()[-3000:]
    assert info["similarity_version"] == "s-good"                     # the working model keeps serving
    assert info["similarity_threshold"] == pytest.approx(0.88)
    # the broken release is not downloaded again on every poll (MODEL_POLL_SECONDS=2 in tests)
    info = _wait_for_model_info(client, lambda i: "not downloaded again" in (i["last_similarity_reload_error"] or ""), 20)
    assert "not downloaded again" in info["last_similarity_reload_error"]
