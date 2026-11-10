from fastapi.testclient import TestClient

import app.web as web
from app.api import app


def test_without_build_front_page_is_api_docs_and_pipeline_is_classic(monkeypatch, tmp_path):
    monkeypatch.setattr(web, "WEB_DIR", tmp_path / "missing")
    client = TestClient(app)
    r = client.get("/", follow_redirects=False)
    assert r.status_code in (302, 307) and r.headers["location"] == "/docs"
    assert "Continuous training" in client.get("/pipeline").text


def test_built_app_is_served_on_its_routes(monkeypatch, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><div id=root></div><!--signatureai-web-->")
    (tmp_path / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    monkeypatch.setattr(web, "WEB_DIR", tmp_path)
    client = TestClient(app)
    for path in ("/", "/verify", "/pipeline"):
        r = client.get(path)
        assert r.status_code == 200 and "signatureai-web" in r.text, path
        assert r.headers["cache-control"] == "no-store"
    assert client.get("/favicon.svg").headers["content-type"].startswith("image/svg+xml")
    # the API itself is untouched
    assert client.get("/health").json()["status"] == "ok"
