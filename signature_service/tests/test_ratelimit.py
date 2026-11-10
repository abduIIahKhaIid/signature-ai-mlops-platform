import dataclasses

import fakeredis
import pytest
from fastapi.testclient import TestClient

import app.ratelimit as ratelimit
import app.web as web
from app.api import app

TEXT = {"file": ("note.txt", b"not an image", "text/plain")}  # passes the limiter, then 415: no job is queued


@pytest.fixture()
def limited(monkeypatch):
    monkeypatch.setattr(ratelimit, "_client", fakeredis.FakeRedis())
    monkeypatch.setattr(ratelimit, "settings", dataclasses.replace(
        ratelimit.settings, rate_limit_per_minute=3, pipeline_admin_token="adm"))
    return TestClient(app)


def test_jobs_are_limited_per_client(limited):
    codes = [limited.post("/v1/detect", files=TEXT).status_code for _ in range(4)]
    assert codes == [415, 415, 415, 429]
    blocked = limited.post("/v1/verify", files={"reference": TEXT["file"], "candidate": TEXT["file"]})
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) in range(0, 61)
    assert "too many requests" in blocked.json()["detail"]
    # other endpoints are not limited
    assert limited.get("/health").status_code == 200


def test_admin_token_bypasses_the_limit(limited):
    for _ in range(5):
        assert limited.post("/v1/detect", files=TEXT, headers={"X-Admin-Token": "adm"}).status_code == 415
    assert limited.post("/v1/detect", files=TEXT, headers={"X-Admin-Token": "wrong"}).status_code == 415  # 1st of 3
    for _ in range(2):
        limited.post("/v1/detect", files=TEXT)
    assert limited.post("/v1/detect", files=TEXT).status_code == 429


def test_redis_down_lets_requests_through(monkeypatch):
    class Down:
        def pipeline(self):
            raise ConnectionError("redis down")

    monkeypatch.setattr(ratelimit, "_client", Down())
    monkeypatch.setattr(ratelimit, "settings", dataclasses.replace(ratelimit.settings, rate_limit_per_minute=1))
    client = TestClient(app)
    assert [client.post("/v1/detect", files=TEXT).status_code for _ in range(3)] == [415, 415, 415]


def test_responses_are_gzipped(monkeypatch, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html>" + "<p>signature</p>" * 400)
    monkeypatch.setattr(web, "WEB_DIR", tmp_path)
    r = TestClient(app).get("/", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip"
