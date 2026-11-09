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


class FakeRedis:
    def __init__(self):
        self.store = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True


@pytest.fixture()
def wired(monkeypatch):
    """Legacy backend: HF webhook -> GitHub Actions repository_dispatch."""
    fake, calls = FakeRedis(), []
    monkeypatch.setattr(webhooks, "_redis", lambda: fake)
    monkeypatch.setattr(webhooks, "_dispatch_to_github", lambda repo, sha: calls.append((repo, sha)) or 204)
    monkeypatch.setattr(webhooks, "settings", dataclasses.replace(
        webhooks.settings, hf_webhook_secret=SECRET, hf_dataset_repo="netsol/sigs", retrain_backend="github",
        github_repo="me/signature-project", github_token="ghp_x", retrain_cooldown_seconds=1800))
    return TestClient(app), calls, fake


@pytest.fixture()
def ec2(monkeypatch):
    """Default backend: HF webhook -> pipeline worker on this EC2 host (Celery queue 'pipeline')."""
    fake, sent = fakeredis.FakeRedis(), []
    monkeypatch.setattr(webhooks, "_redis", lambda: fake)
    monkeypatch.setattr(celery_app, "send_task", lambda name, **kw: sent.append((name, kw)))
    monkeypatch.setattr(webhooks, "settings", dataclasses.replace(
        webhooks.settings, hf_webhook_secret=SECRET, hf_dataset_repo="netsol/sigs", retrain_backend="ec2",
        pipeline_debounce_seconds=45))
    return TestClient(app), sent, fake


def payload(sha="abc123", repo="netsol/sigs", scope="repo.content", action="update", rtype="dataset"):
    return {"event": {"action": action, "scope": scope},
            "repo": {"type": rtype, "name": repo, "headSha": sha}}


def post(client, body, secret=SECRET):
    return client.post("/webhooks/huggingface", json=body, headers={"X-Webhook-Secret": secret})


def test_not_configured_returns_503(monkeypatch):
    monkeypatch.setattr(webhooks, "settings", dataclasses.replace(webhooks.settings, hf_webhook_secret=None))
    assert post(TestClient(app), payload()).status_code == 503


def test_wrong_secret_rejected(wired):
    client, calls, _ = wired
    assert post(client, payload(), secret="nope").status_code == 401
    assert calls == []


def test_dataset_update_dispatches_once_per_commit(wired):
    client, calls, _ = wired
    first = post(client, payload("sha-1"))
    assert first.status_code == 202 and first.json()["dispatched"] is True
    assert calls == [("netsol/sigs", "sha-1")]
    again = post(client, payload("sha-1")).json()
    assert again["dispatched"] is False and "already" in again["reason"]


def test_cooldown_groups_quick_pushes(wired):
    client, calls, _ = wired
    post(client, payload("sha-1"))
    second = post(client, payload("sha-2")).json()
    assert second["dispatched"] is False and "cooldown" in second["reason"]
    assert len(calls) == 1


@pytest.mark.parametrize("body", [
    payload(repo="someone/else"),
    payload(scope="discussion"),
    payload(rtype="model"),
    payload(action="delete"),
])
def test_irrelevant_events_ignored(wired, body):
    client, calls, _ = wired
    r = post(client, body)
    assert r.status_code == 202 and r.json()["dispatched"] is False
    assert calls == []


def test_sha_from_updated_refs(wired):
    client, calls, _ = wired
    body = {"event": {"action": "update", "scope": "repo.content"},
            "repo": {"type": "dataset", "name": "netsol/sigs"},
            "updatedRefs": [{"ref": "refs/heads/main", "oldSha": "a", "newSha": "b"}]}
    assert post(client, body).json()["hf_sha"] == "b"


def test_ec2_backend_queues_one_debounced_dataset_check(ec2):
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


def test_ec2_backend_needs_only_the_webhook_secret(ec2):
    client, sent, _ = ec2
    assert post(client, payload(), secret="nope").status_code == 401
    assert post(client, payload(scope="discussion")).json()["accepted"] is False
    assert sent == []


def test_pipeline_state_and_admin_check(monkeypatch):
    fake, sent = fakeredis.FakeRedis(), []
    monkeypatch.setattr(pipeline_api, "_store", lambda: PipelineStore(fake))
    monkeypatch.setattr(celery_app, "send_task", lambda name, **kw: sent.append((name, kw)) or type("R", (), {"id": "t1"})())
    monkeypatch.setattr(pipeline_api, "settings", dataclasses.replace(pipeline_api.settings, pipeline_admin_token="adm"))
    client = TestClient(app)
    state = client.get("/v1/pipeline/state").json()
    assert state["run"] is None and state["phases"][0]["key"] == "trigger"
    assert "Continuous training" in client.get("/pipeline").text
    assert client.post("/v1/pipeline/check").status_code == 401
    assert client.post("/v1/pipeline/check?force=true", headers={"X-Admin-Token": "adm"}).json()["force"] is True
    assert sent[0][1]["kwargs"] == {"source": "manual", "force": True}
