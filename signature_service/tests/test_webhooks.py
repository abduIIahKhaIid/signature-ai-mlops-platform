import dataclasses

import fakeredis
import pytest
from fastapi.testclient import TestClient

import app.pipeline_api as pipeline_api
import app.webhooks as webhooks
from app.api import app
from app.celery_app import celery_app
from app.retrain import PipelineStore

SECRET = "hf-secret"


@pytest.fixture()
def ec2(monkeypatch):
    """HF webhook -> pipeline worker on this EC2 host (Celery queue 'pipeline') -> Kaggle."""
    fake, sent = fakeredis.FakeRedis(), []
    monkeypatch.setattr(webhooks, "_redis", lambda: fake)
    monkeypatch.setattr(celery_app, "send_task", lambda name, **kw: sent.append((name, kw)))
    monkeypatch.setattr(webhooks, "settings", dataclasses.replace(
        webhooks.settings, hf_webhook_secret=SECRET, hf_dataset_repo="netsol/sigs", pipeline_debounce_seconds=45))
    return TestClient(app), sent, fake


def payload(sha="abc123", repo="netsol/sigs", scope="repo.content", action="update", rtype="dataset"):
    return {"event": {"action": action, "scope": scope},
            "repo": {"type": rtype, "name": repo, "headSha": sha}}


def post(client, body, secret=SECRET):
    return client.post("/webhooks/huggingface", json=body, headers={"X-Webhook-Secret": secret})


def test_without_a_server_secret_unsigned_webhooks_are_accepted(ec2, monkeypatch):
    client, sent, _ = ec2
    monkeypatch.setattr(webhooks, "settings", dataclasses.replace(webhooks.settings, hf_webhook_secret=None))
    r = client.post("/webhooks/huggingface", json=payload("sha-x"))  # no X-Webhook-Secret header at all
    assert r.status_code == 202 and r.json()["accepted"] is True and len(sent) == 1


def test_wrong_secret_rejected(ec2):
    client, sent, _ = ec2
    assert post(client, payload(), secret="nope").status_code == 401
    assert post(client, payload(), secret="").status_code == 401
    assert sent == []


@pytest.mark.parametrize("body", [
    payload(repo="someone/else"),
    payload(scope="discussion"),
    payload(rtype="model"),
    payload(action="delete"),
])
def test_irrelevant_events_ignored(ec2, body):
    client, sent, _ = ec2
    r = post(client, body)
    assert r.status_code == 202 and r.json()["accepted"] is False
    assert sent == []


def test_sha_from_updated_refs(ec2):
    client, sent, _ = ec2
    body = {"event": {"action": "update", "scope": "repo.content"},
            "repo": {"type": "dataset", "name": "netsol/sigs"},
            "updatedRefs": [{"ref": "refs/heads/main", "oldSha": "a", "newSha": "b"}]}
    assert post(client, body).json()["hf_sha"] == "b"
    assert sent[0][1]["kwargs"]["hf_sha"] == "b"


def test_dataset_update_queues_one_debounced_check(ec2):
    client, sent, fake = ec2
    r = post(client, payload("sha-1"))
    assert r.status_code == 202 and r.json()["accepted"] is True and r.json()["check"] == "queued"
    assert sent == [("pipeline.check", {"kwargs": {"source": "webhook", "hf_sha": "sha-1"},
                                        "queue": "pipeline", "countdown": 45})]
    # an upload that makes a second commit within the window -> still one check (it reads the repo head)
    assert post(client, payload("sha-2")).json()["check"].startswith("already queued")
    assert len(sent) == 1
    decisions = PipelineStore(fake).decisions()
    assert [d["decision"] for d in decisions] == ["webhook", "webhook"]


def test_pipeline_state_and_admin_check(monkeypatch):
    fake, sent = fakeredis.FakeRedis(), []
    monkeypatch.setattr(pipeline_api, "_store", lambda: PipelineStore(fake))
    monkeypatch.setattr(celery_app, "send_task", lambda name, **kw: sent.append((name, kw)) or type("R", (), {"id": "t1"})())
    monkeypatch.setattr(pipeline_api, "settings", dataclasses.replace(pipeline_api.settings, pipeline_admin_token="adm"))
    client = TestClient(app)
    state = client.get("/v1/pipeline/state").json()
    assert state["run"] is None and state["phases"][0]["key"] == "trigger"
    assert state["orchestrator"]["backend"] == "ec2"
    assert "Continuous training" in client.get("/pipeline").text
    assert client.post("/v1/pipeline/check").status_code == 401
    assert client.post("/v1/pipeline/check?force=true", headers={"X-Admin-Token": "adm"}).json()["force"] is True
    assert sent[0][1]["kwargs"] == {"source": "manual", "force": True}
