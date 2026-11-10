"""Full mock of the EC2 continuous-training system, end to end, on one machine (CPU):

  real:  FastAPI app (webhook + /pipeline dashboard + /v1/pipeline/state), Redis, the orchestrator code,
         kaggle_job.py build, the generated Kaggle notebook (all cells, via run_mock_pipeline.py)
  fake:  Hugging Face repo (ZIPs in a local folder), S3 (moto server), Kaggle (runs the notebook in a
         subprocess), inference workers (adopt the new alias 15 s after it moves), Celery (direct calls)

Scenario:  1) webhook with an empty repo  -> "no dataset"
           2) upload dataset A            -> run 1: clean, train, evaluate, gate deploys, workers hot-reload
           3) re-upload A under a new name -> "already trained", no Kaggle run
           4) upload dataset B, strict gate -> run 2: gate rejects, served model kept
Screenshots of the dashboard are saved at each step.

Usage: python pipeline/mock/run_mock_orchestrator.py <repo_root> <screenshot_dir>
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(sys.argv[1]).resolve()
SHOTS = Path(sys.argv[2]).resolve()
SHOTS.mkdir(parents=True, exist_ok=True)
WORK = Path("/tmp/mock_orch")
shutil.rmtree(WORK, ignore_errors=True)
(WORK / "hf").mkdir(parents=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


REDIS_PORT, S3_PORT, API_PORT = free_port(), free_port(), free_port()
BUCKET, PREFIX, SECRET = "signatureai-df-detr-models", "signatureai/detection", "hf-webhook-secret"
os.environ.update({
    "CELERY_BROKER_URL": f"redis://127.0.0.1:{REDIS_PORT}/0", "CELERY_RESULT_BACKEND": f"redis://127.0.0.1:{REDIS_PORT}/1",
    "AWS_ENDPOINT_URL_S3": f"http://127.0.0.1:{S3_PORT}", "AWS_ACCESS_KEY_ID": "mock", "AWS_SECRET_ACCESS_KEY": "mock",
    "AWS_DEFAULT_REGION": "us-east-1", "AWS_REGION": "us-east-1", "AWS_S3_BUCKET": BUCKET,
    "MODEL_S3_BUCKET": BUCKET, "MODEL_S3_PREFIX": PREFIX, "MODEL_ALIAS": "latest", "HF_WEBHOOK_SECRET": SECRET,
    "HF_DATASET_REPO": "mabdullahkhalid/Signature_Dataset_Detection",
    "PIPELINE_DEBOUNCE_SECONDS": "2", "PIPELINE_ADMIN_TOKEN": "admin", "KAGGLE_USERNAME": "mabdullahkhalid",
    "PIPELINE_DIR": str(REPO / "pipeline"), "PIPELINE_WORK_DIR": str(WORK / "runs"), "RETRAIN_MODE": "smoke",
    "PIPELINE_TICK_SECONDS": "3", "PIPELINE_POLL_MINUTES": "0", "MODEL_POLL_SECONDS": "15",
    "GATE_MIN_TEST_MAP50": "0.0", "GATE_MAX_REGRESSION": "1.0", "LOGFIRE_TOKEN": "",
    "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
})
sys.path.insert(0, str(REPO / "signature_service"))
sys.path.insert(0, str(REPO / "pipeline" / "mock"))

redis_proc = subprocess.Popen(["redis-server", "--port", str(REDIS_PORT), "--save", "", "--appendonly", "no"],
                              stdout=subprocess.DEVNULL)
from moto.server import ThreadedMotoServer  # noqa: E402

moto = ThreadedMotoServer(ip_address="127.0.0.1", port=S3_PORT)
moto.start()
time.sleep(1)

import boto3  # noqa: E402
import redis  # noqa: E402
import uvicorn  # noqa: E402

from run_mock_pipeline import make_dataset_zip, sha256  # noqa: E402
from tests.helpers import publish_version  # noqa: E402

s3 = boto3.client("s3")
s3.create_bucket(Bucket=BUCKET)
publish_version(s3, BUCKET, PREFIX, "v20261109T142002Z-8a4d7444", WORK / "published", seed=3)  # the model served today

from app import retrain  # noqa: E402
from app.api import app  # noqa: E402
from app.celery_app import celery_app  # noqa: E402
from app.config import settings  # noqa: E402


# ------------------------------------------------------------------ fake Hugging Face repo (a folder of ZIPs)
class FolderHf:
    def __init__(self):
        self.commit, self.files = "0" * 40, []

    def upload(self, path: Path, name: str) -> str:
        dest = WORK / "hf" / name
        shutil.copy(path, dest)
        self.commit = hashlib.sha1(f"{name}{time.time()}".encode()).hexdigest()
        self.files.insert(0, {"path": name, "size": dest.stat().st_size, "sha256": sha256(dest), "blob_id": None,
                              "fingerprint": sha256(dest), "committed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                              "commit_title": f"Upload {name}", "local": str(dest)})
        return self.commit

    def inspect(self, repo, revision="main"):
        return {"repo": repo, "commit": self.commit, "zips": [dict(f) for f in self.files], "files": len(self.files) + 1,
                "url": f"https://huggingface.co/datasets/{repo}/tree/{self.commit}"}


# ------------------------------------------------------------------ fake Kaggle: runs the real notebook on CPU
class SubprocessKaggle(retrain.KaggleCLI):
    def __init__(self, hf: FolderHf):
        super().__init__("mabdullahkhalid", "signatureai-retrain", "signatureai-pipeline-secrets", "NvidiaTeslaT4")
        self.hf, self.proc, self.version, self.started, self.log = hf, None, 0, None, None

    def problems(self):
        return []

    def secrets_ready(self):
        return True, "ready"

    def push(self, build_dir: Path) -> dict:
        nb = json.loads((build_dir / "train_pipeline.ipynb").read_text())
        overrides = next("".join(c["source"]) for c in nb["cells"] if "".join(c["source"]).startswith("# PIPELINE OVERRIDES"))
        zip_name = overrides.split("HF_ZIP_FILENAME = '")[1].split("'")[0]
        commit = overrides.split("HF_REVISION = '")[1].split("'")[0]
        local = next(f["local"] for f in self.hf.files if f["path"] == zip_name)
        self.version += 1
        self.log = open(WORK / f"kaggle_v{self.version}.log", "w")
        self.started = time.time()
        self.proc = subprocess.Popen([sys.executable, str(REPO / "pipeline" / "mock" / "run_mock_pipeline.py"), str(REPO),
                                      "--notebook", str(build_dir / "train_pipeline.ipynb"), "--dataset-zip", local,
                                      "--hf-commit", commit, "--bucket", BUCKET,
                                      "--evidence", str(WORK / f"evidence_v{self.version}.json")],
                                     stdout=self.log, stderr=subprocess.STDOUT, env=dict(os.environ))
        return {"version": self.version, "output": "Kernel version pushed"}

    def status(self):
        if self.proc is None:
            return "complete", None
        if time.time() - self.started < 6:
            return "queued", None
        code = self.proc.poll()
        if code is None:
            return "running", None
        return ("complete", None) if code == 0 else ("error", "notebook raised an exception")

    def logs(self, max_lines=60):
        return "\n".join(Path(self.log.name).read_text().splitlines()[-max_lines:])

    def output(self, dest: Path):
        return []


# ------------------------------------------------------------------ fake inference workers (hot reload after 15 s)
served = {"version": "v20261109T142002Z-8a4d7444", "seen_alias": None, "since": 0}


def probe():
    alias = json.loads(s3.get_object(Bucket=BUCKET, Key=f"{PREFIX}/aliases/latest.json")["Body"].read())["version"]
    if alias != served["seen_alias"]:
        served["seen_alias"], served["since"] = alias, time.time()
    if alias != served["version"] and time.time() - served["since"] > settings.model_poll_seconds:
        served["version"] = alias
    return {"detector_version": served["version"], "similarity_version": "v20261109T202146Z-577f3f2a"}


hf = FolderHf()
store = retrain.PipelineStore(redis.Redis.from_url(settings.broker_url))
orch = retrain.Orchestrator(settings, store, s3, hf, SubprocessKaggle(hf), probe)


# Celery stand-in: the API's send_task("pipeline.check", countdown=..) runs the orchestrator after the countdown
def fake_send_task(name, kwargs=None, countdown=0, **_):
    def run():
        time.sleep(countdown or 0)
        orch.request_check(**(kwargs or {}))
    threading.Thread(target=run, daemon=True).start()
    return type("Result", (), {"id": "mock-task"})()


celery_app.send_task = fake_send_task
stop = threading.Event()


def beat():
    while not stop.is_set():
        try:
            orch.tick()
        except Exception as exc:
            print("tick error", exc)
        stop.wait(settings.pipeline_tick_seconds)


threading.Thread(target=beat, daemon=True).start()
server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=API_PORT, log_level="warning"))
threading.Thread(target=server.run, daemon=True).start()
time.sleep(2)

import httpx  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

api = httpx.Client(base_url=f"http://127.0.0.1:{API_PORT}", timeout=30)


def webhook(commit: str):
    body = {"event": {"action": "update", "scope": "repo.content"},
            "repo": {"type": "dataset", "name": settings.hf_dataset_repo, "headSha": commit}}
    r = api.post("/webhooks/huggingface", json=body, headers={"X-Webhook-Secret": SECRET})
    print("webhook ->", r.status_code, r.json())


def state():
    return api.get("/v1/pipeline/state").json()


def wait_for(pred, timeout=900, every=2.0, label=""):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = state()
        if pred(s):
            return s
        time.sleep(every)
    raise TimeoutError(label)


pw = sync_playwright().start()
browser = pw.chromium.launch(executable_path=shutil.which("google-chrome"), args=["--no-sandbox"])
page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
page.goto(f"http://127.0.0.1:{API_PORT}/pipeline")


def shot(name: str, full=True):
    page.wait_for_timeout(3500)  # one dashboard refresh
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=full)
    print("screenshot", name)


timeline = []
try:
    # 1) webhook while the repo has no dataset ZIP
    webhook("0" * 40)
    s = wait_for(lambda s: s["decisions"] and s["decisions"][0]["decision"] == "no_dataset", 60, label="no_dataset")
    timeline.append(("empty repo", s["decisions"][0]["decision"], s["decisions"][0]["message"]))
    shot("01_idle_no_dataset", full=False)

    # 2) upload dataset A -> full run, gate deploys, workers hot-reload
    zip_a = WORK / "src_a.zip"
    make_dataset_zip(zip_a, seed=7, dirty=True)
    webhook(hf.upload(zip_a, "signature_dataset_2026-11-10.zip"))
    s = wait_for(lambda s: s["run"] and s["run"]["phases"]["training"]["status"] == "running", 300, 1, "training")
    page.wait_for_timeout(9000)
    shot("02_live_training")
    s = wait_for(lambda s: s["run"] and s["run"]["status"] not in ("running", "deploying"), 900, 3, "run1 end")
    run1 = s["run"]
    timeline.append(("upload A", run1["status"], f"{run1['result']['version']} served_after={run1['served_after']}"))
    page.evaluate("window.scrollTo(0,0)")
    shot("03_run1_deployed")

    # 3) same bytes uploaded again under another name -> skipped, no Kaggle run
    pushes_before = orch.kaggle.version
    webhook(hf.upload(zip_a, "signature_dataset_COPY_reupload.zip"))
    s = wait_for(lambda s: s["decisions"] and s["decisions"][0]["decision"] in ("skipped_trained", "started"), 60, label="dedup")
    assert s["decisions"][0]["decision"] == "skipped_trained" and orch.kaggle.version == pushes_before
    timeline.append(("re-upload A (new name)", s["decisions"][0]["decision"], s["decisions"][0]["message"]))
    shot("04_reupload_skipped", full=False)
    page.locator("text=Trigger decisions").scroll_into_view_if_needed()
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOTS / "04b_decisions.png"), full_page=False)

    # 4) different dataset B with the real gate floor -> rejected, served model kept
    orch.cfg = dataclasses.replace(settings, gate_min_test_map50=0.75, gate_max_regression=0.02)
    zip_b = WORK / "src_b.zip"
    make_dataset_zip(zip_b, seed=99, dirty=False)
    webhook(hf.upload(zip_b, "signature_dataset_v2.zip"))
    s = wait_for(lambda s: s["run"] and s["run"]["id"] != run1["id"] and s["run"]["status"] not in ("running", "deploying"),
                 900, 3, "run2 end")
    run2 = s["run"]
    timeline.append(("upload B (strict gate)", run2["status"], "; ".join(run2["result"]["gate"]["reasons"])))
    page.evaluate("window.scrollTo(0,0)")
    shot("05_run2_rejected")
    final = state()
    (SHOTS / "final_state.json").write_text(json.dumps(final, indent=2, default=str))
finally:
    print("\n=========== SCENARIO RESULT ===========")
    for row in timeline:
        print(" | ".join(map(str, row)))
    stop.set()
    browser.close(); pw.stop()
    server.should_exit = True
    moto.stop()
    redis_proc.terminate()
