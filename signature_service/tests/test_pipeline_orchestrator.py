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
                     "INIT_FROM = 'latest'", "DEPLOY_ALIAS = 'latest'", "GATE_MIN_TEST_MAP50 = 0.75", "PIPELINE_MODE = 'full'"):
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
