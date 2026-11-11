"""EC2 retraining orchestrator: dataset check, content-SHA dedup, single active run, Kaggle monitoring,
live-progress merge, gate outcomes and hot-reload confirmation. Outside services are fakes."""
import dataclasses
import json
import types
from pathlib import Path

import boto3
import fakeredis
import pytest
from moto import mock_aws

from app.config import settings
from app.retrain import NOTEBOOK_PHASES, HfInspector, Orchestrator, PipelineStore, dashboard_state

REPO_ROOT = Path(__file__).resolve().parents[2]
BUCKET, PREFIX = "models", "signatureai/detection"
SHA_A, SHA_B = "a" * 64, "b" * 64


class FakeHf:
    def __init__(self):
        self.zips = []
        self.commit = "c0ffee00"

    def inspect(self, repo, revision="main"):
        return {"repo": repo, "commit": self.commit, "zips": list(self.zips), "files": len(self.zips) + 1,
                "url": f"https://huggingface.co/datasets/{repo}/tree/{self.commit}"}

    def upload(self, name, sha, commit):
        self.commit = commit
        self.zips.insert(0, {"path": name, "size": 123_000_000, "sha256": sha, "blob_id": None, "fingerprint": sha,
                             "committed_at": f"2026-11-10T0{len(self.zips)}:00:00+00:00", "commit_title": f"upload {name}"})


class FakeKaggle:
    kernel, secrets_dataset, accelerator = "me/signatureai-retrain", "me/signatureai-pipeline-secrets", "NvidiaTeslaT4"
    url = "https://www.kaggle.com/code/me/signatureai-retrain"

    def __init__(self):
        self.pushes, self.state, self.message = [], "complete", None
        self.missing = []

    def problems(self):
        return list(self.missing)

    def secrets_ready(self):
        return True, "ready"

    def push(self, build_dir):
        nb = json.loads((Path(build_dir) / "train_pipeline.ipynb").read_text())
        overrides = next("".join(c["source"]) for c in nb["cells"] if "".join(c["source"]).startswith("# PIPELINE OVERRIDES"))
        self.pushes.append(overrides)
        self.state = "complete"  # Kaggle still reports the PREVIOUS version for a moment
        return {"version": len(self.pushes)}

    def status(self):
        return self.state, self.message

    def logs(self, max_lines=60):
        return "Traceback (most recent call last):\nRuntimeError: CUDA out of memory"

    def output(self, dest):
        return []


class Clock:
    def __init__(self):
        import time
        self.t = time.time()

    def __call__(self):
        return self.t


@pytest.fixture()
def env(tmp_path):
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/aliases/latest.json", Body=json.dumps({"version": "v-old"}))
        cfg = dataclasses.replace(settings, hf_dataset_repo="me/sigs", model_s3_bucket=BUCKET, model_s3_prefix=PREFIX,
                                  model_alias="latest", pipeline_dir=str(REPO_ROOT / "pipeline"),
                                  pipeline_work_dir=str(tmp_path), pipeline_poll_minutes=30, model_poll_seconds=300,
                                  retrain_mode="full", pipeline_max_auto_attempts=2, kaggle_username="me")
        serving = {"detector_version": "v-old"}
        store = PipelineStore(fakeredis.FakeRedis())
        hf, kaggle, clock = FakeHf(), FakeKaggle(), Clock()
        orch = Orchestrator(cfg, store, s3, hf, kaggle, probe=lambda: dict(serving), clock=clock)
        yield types.SimpleNamespace(s3=s3, cfg=cfg, store=store, hf=hf, kaggle=kaggle, clock=clock, orch=orch,
                                    serving=serving)


def put_live(env, run_id, **live):
    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pipeline_runs/live/{run_id}.json", Body=json.dumps(live))


def notebook_finishes(env, run_id, status="deployed", version="v-new", fingerprint=SHA_A):
    """What the Kaggle notebook writes at the end: live JSON with the result + the dataset marker."""
    result = {"status": status, "version": version, "test_map50": 0.83,
              "gate": {"passed": status != "rejected", "baseline_test_map50": 0.80,
                       "reasons": [] if status != "rejected" else ["test mAP@50 0.61 < floor 0.75"]}}
    phases = {k: {"status": "done", "started_at": "2026-11-10T00:00:00+00:00"} for k in NOTEBOOK_PHASES}
    put_live(env, run_id, status="finished", current=None, phases=phases, data={"result": result},
             events=[{"ts": "2026-11-10T00:00:00+00:00", "message": "phase started: download"},
                     {"ts": "2026-11-10T00:30:00+00:00", "message": "notebook finished"}])
    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pipeline_runs/datasets/{fingerprint}.json",
                      Body=json.dumps({"version": version, "status": status}))


def test_no_dataset_zip_means_no_training(env):
    out = env.orch.request_check("webhook")
    assert out["decision"] == "no_dataset"
    assert env.kaggle.pushes == [] and env.store.active() is None


def test_new_dataset_starts_one_pinned_kaggle_run(env):
    env.hf.upload("export_nov10.zip", SHA_A, "commit-1")
    out = env.orch.request_check("webhook", hf_sha="commit-1")
    assert out["decision"] == "started"
    run = env.store.get_run(out["run_id"])
    assert env.store.active() == run["id"]
    assert [run["phases"][k]["status"] for k in ("trigger", "dataset_check", "dedup", "kaggle_submit", "kaggle_start")] == \
        ["done", "done", "done", "done", "running"]
    overrides = env.kaggle.pushes[0]
    # the notebook is pinned to exactly what was checked, and reports live progress for this run
    for expected in ("HF_ZIP_FILENAME = 'export_nov10.zip'", "HF_REVISION = 'commit-1'", f"EXPECTED_ZIP_SHA256 = '{SHA_A}'",
                     f"DATASET_FINGERPRINT = '{SHA_A}'", f"PIPELINE_RUN_ID = '{run['id']}'", "LIVE_PROGRESS = True",
                     "INIT_FROM = 'latest'", "DEPLOY_ALIAS = 'latest'", "GATE_MIN_TEST_MAP50 = 0.75", "PIPELINE_MODE = 'full'",
                     "GATE_MAX_VAL_TEST_GAP = 0.05", "COMET_PROJECT = 'signature-ai-detection-retrain'"):
        assert expected in overrides, expected
    assert run["served_before"] == "v-old"


def test_webhook_during_a_run_is_deferred_then_rechecked(env):
    env.hf.upload("a.zip", SHA_A, "commit-1")
    first = env.orch.request_check("webhook")
    assert env.orch.request_check("webhook")["decision"] == "deferred"
    assert len(env.kaggle.pushes) == 1
    # run finishes (gate rejects) -> the pending re-check sees the same dataset -> skipped, nothing new pushed
    env.kaggle.state = "running"; env.orch.tick()
    notebook_finishes(env, first["run_id"], status="rejected")
    env.kaggle.state = "complete"; env.orch.tick()
    assert env.store.get_run(first["run_id"])["status"] == "rejected"
    env.orch.tick()  # pending re-check
    assert env.store.decisions(1)[0]["decision"] == "skipped_trained"
    assert len(env.kaggle.pushes) == 1


def test_same_dataset_reuploaded_is_never_retrained(env):
    env.hf.upload("export.zip", SHA_A, "commit-1")
    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pipeline_runs/datasets/{SHA_A}.json",
                      Body=json.dumps({"version": "v-trained", "status": "deployed"}))
    env.hf.upload("export_renamed_copy.zip", SHA_A, "commit-2")  # same bytes, new name, new commit
    out = env.orch.request_check("webhook", hf_sha="commit-2")
    assert out["decision"] == "skipped_trained" and "v-trained" in out["message"]
    assert env.kaggle.pushes == []
    # a dataset with different content does start
    env.hf.upload("export_v2.zip", SHA_B, "commit-3")
    assert env.orch.request_check("webhook")["decision"] == "started"
    # and the dashboard button can force a retrain of trained data
    env.store.release_active(env.store.active())
    env.hf.zips = [z for z in env.hf.zips if z["sha256"] == SHA_A]
    assert env.orch.request_check("manual", force=True)["decision"] == "started"


def test_stale_kaggle_status_right_after_push_is_ignored(env):
    env.hf.upload("a.zip", SHA_A, "commit-1")
    run_id = env.orch.request_check("webhook")["run_id"]
    env.orch.tick()  # Kaggle still says "complete" (previous version), nothing seen yet
    run = env.store.get_run(run_id)
    assert run["status"] == "running" and run["result"] is None


def test_full_run_live_progress_gate_deploy_and_hot_reload(env):
    env.hf.upload("a.zip", SHA_A, "commit-1")
    run_id = env.orch.request_check("webhook")["run_id"]
    env.kaggle.state = "running"
    put_live(env, run_id, status="running", current="training", gpu={"name": "Tesla T4"},
             phases={"download": {"status": "done"}, "clean": {"status": "done"}, "training": {"status": "running"}},
             progress=[{"desc": "Epoch 2/8 Training", "n": 1450, "total": 2870, "rate": 3.1}],
             epochs=[{"epoch": 1, "train_loss": 9.1, "val_map50": 0.79}], data={"dataset_summary": {"source_images": 57000}},
             events=[{"ts": "2026-11-10T00:01:00+00:00", "message": "phase started: training"}])
    env.orch.tick()
    run = env.store.get_run(run_id)
    assert run["phases"]["kaggle_start"]["status"] == "done" and "T4" in run["phases"]["kaggle_start"]["detail"]
    assert run["phases"]["training"]["status"] == "running"
    assert run["live"]["progress"][0]["n"] == 1450 and run["live"]["epochs"][0]["val_map50"] == 0.79
    assert any(e["source"] == "kaggle" and "training" in e["message"] for e in run["events"])

    notebook_finishes(env, run_id, status="deployed", version="v-new")
    env.kaggle.state = "complete"
    env.orch.tick()
    run = env.store.get_run(run_id)
    assert run["status"] == "deploying" and run["phases"]["gate"]["status"] == "done"
    assert run["phases"]["hot_reload"]["status"] == "running"

    env.serving["detector_version"] = "v-new"  # workers poll the alias and swap the model
    env.orch.tick()
    run = env.store.get_run(run_id)
    assert run["status"] == "succeeded" and run["served_after"] == "v-new"
    assert run["phases"]["hot_reload"]["status"] == "done" and env.store.active() is None

    state = dashboard_state(env.store, env.cfg)
    assert state["run"]["id"] == run_id and state["runs"][0]["version"] == "v-new"
    assert [p["key"] for p in state["phases"]][0] == "trigger"


def test_kaggle_error_fails_run_with_log_and_limits_auto_retries(env):
    env.hf.upload("a.zip", SHA_A, "commit-1")
    for attempt in range(2):
        run_id = env.orch.request_check("schedule")["run_id"]
        env.kaggle.state = "running"; env.orch.tick()
        env.kaggle.state, env.kaggle.message = "error", "Notebook failed"
        env.orch.tick()
        run = env.store.get_run(run_id)
        assert run["status"] == "failed" and "out of memory" in run["log_tail"]
        assert run["phases"]["kaggle_start"]["status"] == "failed"
        assert run["phases"]["gate"]["status"] == "skipped"
    out = env.orch.request_check("schedule")
    assert out["decision"] == "skipped_failed" and len(env.kaggle.pushes) == 2


def test_missing_kaggle_config_blocks_before_anything_runs(env):
    env.hf.upload("a.zip", SHA_A, "commit-1")
    env.kaggle.missing = ["KAGGLE_USERNAME is not set in .env"]
    out = env.orch.request_check("webhook")
    assert out["decision"] == "blocked" and env.store.active() is None


def test_hf_inspector_reads_lfs_sha_and_picks_newest(monkeypatch):
    import datetime as dt

    utc = dt.timezone.utc
    files = [types.SimpleNamespace(path="README.md", size=5, lfs=None, last_commit=None, blob_id="x"),
             types.SimpleNamespace(path="old.zip", size=10, lfs=types.SimpleNamespace(sha256=SHA_B), blob_id="b1",
                                   last_commit=types.SimpleNamespace(date=dt.datetime(2026, 11, 1, tzinfo=utc), title="old")),
             types.SimpleNamespace(path="new.zip", size=20, lfs={"sha256": SHA_A}, blob_id="b2",
                                   last_commit=types.SimpleNamespace(date=dt.datetime(2026, 11, 10, tzinfo=utc), title="new"))]

    class Api:
        def __init__(self, token=None): pass
        def repo_info(self, *a, **k): return types.SimpleNamespace(sha="head")
        def list_repo_tree(self, *a, **k): return files

    import huggingface_hub
    monkeypatch.setattr(huggingface_hub, "HfApi", Api)
    out = HfInspector("t").inspect("me/sigs")
    assert [z["path"] for z in out["zips"]] == ["new.zip", "old.zip"]
    assert out["zips"][0]["fingerprint"] == SHA_A and out["commit"] == "head"


def test_nan_in_a_result_never_breaks_the_dashboard_api(env):
    """Kaggle's pipeline_result.json can contain NaN (e.g. a loss); the state endpoint must stay valid JSON."""
    env.hf.upload("a.zip", SHA_A, "commit-1")
    run_id = env.orch.request_check("webhook")["run_id"]
    run = env.store.get_run(run_id)
    run["result"] = {"status": "rejected", "test_map50": float("nan"), "gate": {"baseline_test_metrics": {"loss": float("inf")}}}
    env.store.save_run(run)
    state = dashboard_state(env.store, env.cfg, run_id)
    json.dumps(state, allow_nan=False)  # raises if any NaN/inf is left
    assert state["run"]["result"]["test_map50"] is None


# ---------------------------------------------------------------------------------------------- v2 dashboard actions
from app import retrain as R  # noqa: E402
from app.alerts import Notifier  # noqa: E402


def _running_in_training(env):
    env.hf.upload("a.zip", SHA_A, "commit-1")
    run_id = env.orch.request_check("webhook")["run_id"]
    env.kaggle.state = "running"
    put_live(env, run_id, status="running", current="training", phases={"training": {"status": "running"}},
             updated_at=R.utcnow(), data={"comet_key": "abc123", "comet_url": "https://www.comet.com/ws/p/abc123"})
    env.orch.tick()
    return run_id


def test_stop_button_stops_the_run_without_marking_failure(env):
    run_id = _running_in_training(env)
    out = R.request_stop(env.store, env.s3, env.cfg, None, "dashboard (1.2.3.4)")
    assert out == {"stopping": run_id}
    ctl = json.loads(env.s3.get_object(Bucket=BUCKET, Key=f"{PREFIX}/pipeline_runs/control/{run_id}.json")["Body"].read())
    assert ctl["stop"] is True
    env.orch.tick()                                   # worker picks the request up
    run = env.store.get_run(run_id)
    assert run["stop_requested_by"] == "dashboard (1.2.3.4)"
    env.kaggle.state = "error"                         # the notebook interrupted itself
    env.orch.tick()
    run = env.store.get_run(run_id)
    assert run["status"] == "stopped" and run["phases"]["training"]["status"] == "stopped"
    assert run["phases"]["gate"]["status"] == "skipped"
    assert env.store.failures(SHA_A) == 0 and env.store.active() is None
    assert env.store.audit_log()[0]["action"] == "stop"
    with pytest.raises(R.ActionError):
        R.request_stop(env.store, env.s3, env.cfg, run_id, "x")   # nothing running any more


def test_stop_refused_once_the_gate_runs(env):
    run_id = _running_in_training(env)
    run = env.store.get_run(run_id)
    R.set_phase(run, "gate", "running")
    env.store.save_run(run)
    with pytest.raises(R.ActionError, match="too late"):
        R.request_stop(env.store, env.s3, env.cfg, run_id, "x")


def test_rollback_moves_alias_to_previous_version(env):
    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/versions/v-old/manifest.json", Body=json.dumps({"artifact_sha256": "f" * 64}))
    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/aliases/latest.json",
                      Body=json.dumps({"version": "v-new", "previous_version": "v-old"}))
    out = R.rollback(env.store, env.s3, env.cfg, "dashboard")
    assert out == {"alias": "latest", "from": "v-new", "to": "v-old"}
    alias = json.loads(env.s3.get_object(Bucket=BUCKET, Key=f"{PREFIX}/aliases/latest.json")["Body"].read())
    assert alias["version"] == "v-old" and alias["previous_version"] == "v-new" and alias["sha256"] == "f" * 64
    assert env.store.audit_log()[0]["action"] == "rollback"
    # rolling back again goes forward to v-new only if its manifest exists
    with pytest.raises(R.ActionError, match="no manifest"):
        R.rollback(env.store, env.s3, env.cfg, "dashboard")


class FakeComet:
    def __init__(self, workspaces=("abdullah-khalid",)):
        self.ws, self.calls = list(workspaces), 0

    def workspaces(self):
        return self.ws

    def experiment(self, key):
        self.calls += 1
        return {"metrics": [{"name": "val_map50", "latest": 0.81, "max": 0.81, "min": 0.79, "history": [0.79, 0.81]}],
                "params": {"lr": "2e-5"}, "console": ["Epoch 1 metrics: ..."], "assets": [{"name": "training_history.csv"}]}


def test_comet_preflight_blocks_a_wrong_workspace_before_any_gpu(env):
    env.orch.comet = FakeComet(workspaces=["someone-else"])
    env.orch.cfg = dataclasses.replace(env.cfg, comet_workspace="abdullah-khalid")
    env.hf.upload("a.zip", SHA_A, "commit-1")
    out = env.orch.request_check("webhook")
    assert out["decision"] == "blocked" and "abdullah-khalid" in out["message"]
    assert env.kaggle.pushes == []


def test_comet_experiment_is_mirrored_into_the_run(env):
    env.orch.comet = FakeComet()
    run_id = _running_in_training(env)
    run = env.store.get_run(run_id)
    assert run["comet"]["enabled"] and run["comet"]["key"] == "abc123"
    assert run["comet"]["metrics"][0]["name"] == "val_map50" and run["comet"]["params"] == {"lr": "2e-5"}
    assert run["comet"]["url"].endswith("/abc123")


def test_secrets_are_synced_from_env_when_complete(env, monkeypatch):
    import sys as _sys
    _sys.path.insert(0, str(REPO_ROOT / "pipeline"))
    import kaggle_job
    pushed = []
    monkeypatch.setattr(kaggle_job, "push_secrets", lambda ds, values, wait_seconds=0: pushed.append((ds, values)))
    env.orch.cfg = dataclasses.replace(env.cfg, comet_api_key="ck", comet_workspace="abdullah-khalid", hf_token="ht",
                                       notebook_aws_access_key_id="AK", notebook_aws_secret_access_key="SK",
                                       notebook_aws_region="ap-southeast-2")
    env.hf.upload("a.zip", SHA_A, "commit-1")
    run_id = env.orch.request_check("webhook")["run_id"]
    assert pushed and pushed[0][0] == env.kaggle.secrets_dataset
    assert pushed[0][1]["COMET_WORKSPACE"] == "abdullah-khalid" and pushed[0][1]["AWS_S3_BUCKET"] == BUCKET
    assert any("secrets synced" in e["message"] for e in env.store.get_run(run_id)["events"])
    assert "COMET_WORKSPACE_NAME = 'abdullah-khalid'" in env.kaggle.pushes[0]


def test_kaggle_quota_is_parsed(monkeypatch):
    k = R.KaggleCLI("me", "k", "s", "T4")
    monkeypatch.setattr(k, "_run", lambda *a, **kw: types.SimpleNamespace(
        stdout="resource,used,remaining,total,refreshAt\nGPU,7.40h,22.60h,30.00h,2026-11-15T00:00:00+00:00\n", stderr=""))
    assert k.quota() == {"used_hours": 7.4, "remaining_hours": 22.6, "total_hours": 30.0, "refresh_at": "2026-11-15T00:00:00+00:00"}


def test_alerts_follow_the_dashboard_toggles(env):
    sent_mail, posts = [], []

    class SMTP:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def starttls(self): pass
        def login(self, u, p): pass
        def send_message(self, m): sent_mail.append(m["Subject"])

    cfg = dataclasses.replace(env.cfg, smtp_host="smtp.example", alert_email_to="me@example.com", alert_webhook_url="https://hooks.example/x")
    n = Notifier(cfg, env.store, smtp_factory=SMTP, http_post=lambda url, body: posts.append(body["text"]))
    assert n.send("deployed", "New model", "live") == ["email", "slack"]
    R.set_alerts(env.store, {"slack": False}, "dashboard")
    assert n.send("deployed", "New model", "live") == ["email"]
    R.set_alerts(env.store, {"email": False, "stuck": True}, "dashboard")
    # a stuck run is urgent: it goes to every configured channel while the "stuck" toggle is on
    assert n.send("stuck", "Stuck", "no heartbeat") == ["email", "slack"]
    assert n.send("failed", "Failed", "x") == []          # email and slack toggles are both off now
    assert len(sent_mail) == 3 and len(posts) == 2


def test_dashboard_has_eta_lineage_and_actions(env):
    run_id = _running_in_training(env)
    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/aliases/latest.json", Body=json.dumps({"version": "v-old", "previous_version": "v-older"}))
    env.orch.refresh_serving(force=True)
    state = dashboard_state(env.store, env.cfg)
    assert state["eta"]["remaining_seconds"] > 0 and state["eta"]["basis"] == "defaults"
    assert state["lineage"]["current"]["run_id"] == run_id and state["lineage"]["serving"] == "v-old"
    assert state["rollback_to"] == "v-older"
    assert set(state["alerts"]["prefs"]) == {"email", "slack", "stuck", "trigger"}
    json.dumps(state, allow_nan=False)


def test_epochs_from_the_dashboard_reach_the_notebook(env):
    from app.retrain import ActionError, set_training, training_settings

    assert training_settings(env.store, env.cfg)["epochs"] == 8 and "default" in training_settings(env.store, env.cfg)["source"]
    with pytest.raises(ActionError):
        set_training(env.store, env.cfg, 99, "test")
    out = set_training(env.store, env.cfg, 5, "test")
    assert out["epochs"] == 5 and out["source"] == "dashboard"
    assert "max epochs 8 -> 5" in env.store.audit_log()[0]["detail"]
    env.hf.upload("export_nov10.zip", SHA_A, "commit-1")
    assert env.orch.request_check("webhook", hf_sha="commit-1")["decision"] == "started"
    overrides = env.kaggle.pushes[-1]
    assert "EPOCHS = 5" in overrides and "EARLY_STOPPING_PATIENCE = 2" in overrides
    assert env.store.get_run(env.store.active())["epochs"] == 5
    assert dashboard_state(env.store, env.cfg)["training"]["epochs"] == 5
    # back to the default for the next run; the running run keeps 5
    assert set_training(env.store, env.cfg, None, "test")["epochs"] == 8
    assert env.store.get_run(env.store.active())["epochs"] == 5
    # RETRAIN_EPOCHS in .env is used when the dashboard has no value
    cfg = dataclasses.replace(env.cfg, retrain_epochs=3)
    assert training_settings(env.store, cfg)["epochs"] == 3


def test_project_name_in_comet_workspace_is_ignored_not_fatal(env):
    # COMET_WORKSPACE=signature-ai-detection-retrain (the project) once crashed the Kaggle run at the Comet preflight
    env.orch.cfg = dataclasses.replace(env.cfg, comet_workspace=env.cfg.comet_project)
    env.hf.upload("a.zip", SHA_A, "commit-1")
    run_id = env.orch.request_check("webhook")["run_id"]
    run = env.store.get_run(run_id)
    assert any(e["level"] == "warning" and "project name" in e["message"] for e in run["events"])
    assert "COMET_WORKSPACE_NAME = None" in env.kaggle.pushes[0]


# ---------------------------------------------------------------------------------------------- trigger alerts
class RecordingNotifier:
    def __init__(self):
        self.sent = []

    def send(self, kind, subject, text):
        self.sent.append((kind, subject, text))
        return ["slack"]


def test_every_upload_tells_the_user_what_happened(env):
    """HF webhook -> one message per decision, without opening the server or the dashboard."""
    env.orch.notifier = n = RecordingNotifier()
    env.orch.cfg = dataclasses.replace(env.cfg, public_url="https://sig.example")

    env.orch.request_check("webhook", hf_sha="c0")                       # repo still empty
    assert n.sent[-1][1] == "No dataset ZIP in the Hugging Face repo"

    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pipeline_runs/datasets/{SHA_B}.json",
                      Body=json.dumps({"version": "v-b", "status": "deployed", "trained_at_utc": "2026-11-10T05:47:41"}))
    env.hf.upload("same_content_new_name.zip", SHA_B, "commit-b")       # the same bytes as an earlier upload
    env.orch.request_check("webhook", hf_sha="commit-b")
    kind, subject, text = n.sent[-1]
    assert kind == "trigger" and subject == "Dataset already trained, no training started: same_content_new_name.zip"
    assert "model v-b" in text and "Retrain anyway" in text and "Hugging Face webhook" in text
    assert "https://sig.example/pipeline" in text and env.kaggle.pushes == []

    env.hf.upload("new_data.zip", SHA_A, "commit-a")
    run_id = env.orch.request_check("webhook", hf_sha="commit-a")["run_id"]
    assert n.sent[-1][1] == "Training started: new_data.zip" and run_id in n.sent[-1][2]

    env.orch.request_check("webhook", hf_sha="commit-a2")               # second upload while Kaggle trains
    assert n.sent[-1][1] == "Training is busy, the dataset will be checked afterwards"
    assert len(n.sent) == 4


def test_scheduled_checks_stay_quiet_unless_they_start_or_break_something(env):
    env.orch.notifier = n = RecordingNotifier()
    env.s3.put_object(Bucket=BUCKET, Key=f"{PREFIX}/pipeline_runs/datasets/{SHA_B}.json", Body=json.dumps({"version": "v-b"}))
    env.hf.upload("b.zip", SHA_B, "commit-b")
    env.orch.request_check("schedule")                                    # every 30 min: no message for "nothing new"
    assert n.sent == []

    env.kaggle.missing = ["KAGGLE_KEY is not set"]
    env.hf.upload("a.zip", SHA_A, "commit-a")
    env.orch.request_check("schedule")
    env.orch.request_check("schedule")                                    # same problem again: no second message
    assert [s[1] for s in n.sent] == ["Retraining is blocked: a.zip"]
    env.orch.request_check("webhook")                                     # a person uploaded: always answered
    assert len(n.sent) == 2

    env.kaggle.missing = []
    env.orch.request_check("schedule")                                    # the poll found new data and started
    assert n.sent[-1][1] == "Training started: a.zip"


def test_trigger_alerts_have_their_own_toggle_and_never_break_the_check(env):
    posts = []
    cfg = dataclasses.replace(env.cfg, alert_webhook_url="https://hooks.example/x")
    notifier = Notifier(cfg, env.store, http_post=lambda url, body: posts.append(body["content"]))
    R.set_alerts(env.store, {"slack": False}, "dashboard")                # run-result messages off ...
    assert notifier.send("trigger", "Training started", "x") == ["slack"]  # ... upload answers still on
    R.set_alerts(env.store, {"trigger": False}, "dashboard")
    assert notifier.send("trigger", "Training started", "x") == []

    class Broken:
        def send(self, *a):
            raise RuntimeError("SMTP down")
    env.orch.notifier = Broken()
    env.hf.upload("a.zip", SHA_A, "commit-a")
    assert env.orch.request_check("webhook")["decision"] == "started"     # the alert failed, the run did not
