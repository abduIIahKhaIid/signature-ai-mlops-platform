"""Stress test for the deployed platform (Locust).

Run from signature_service/ (PowerShell: set each variable with $env:NAME="value" first):

  ADMIN_TOKEN=<PIPELINE_ADMIN_TOKEN> STEPS=1,5,10,20,40 STEP_SECONDS=90 RUN_NAME=ec2_t3large \
      locust -f loadtest/locustfile.py --host http://<server>:8000 --headless \
      --csv loadtest/results/ec2_t3large --html loadtest/results/ec2_t3large.html
  python loadtest/report.py --run loadtest/results/ec2_t3large        # tables + charts -> docs/results

Every simulated user uploads a document, waits for its job to finish (end-to-end: upload -> queue -> worker ->
result), pauses briefly and repeats. Besides Locust's own CSV/HTML this file writes:
  <RUN_NAME>_jobs.csv     one row per job: users at that moment, end-to-end ms, server queue wait, inference, worker
  <RUN_NAME>_system.csv   every 2 s: host CPU %, RAM, load and the number of jobs waiting in Redis (GET /v1/system)
  <RUN_NAME>_meta.json    settings of the run

ADMIN_TOKEN: the API limits jobs per IP (RATE_LIMIT_PER_MINUTE); a load test identifies itself with the admin token.
IMAGES_DIR: real test-split document images (JPG/PNG) give realistic numbers; synthetic pages are used if it is empty.
VERIFY_WEIGHT: share of /v1/verify jobs (default 0 = detection only, the cleanest images-per-second number).
"""
from __future__ import annotations

import csv
import io
import json
import os
import random
import time
from pathlib import Path

import gevent
from locust import HttpUser, LoadTestShape, between, events, task

HERE = Path(__file__).parent
IMAGES_DIR = Path(os.getenv("IMAGES_DIR", HERE / "images"))
RESULTS_DIR = Path(os.getenv("RESULTS_DIR", HERE / "results"))
RUN_NAME = os.getenv("RUN_NAME", "stress")
VERIFY_WEIGHT = int(os.getenv("VERIFY_WEIGHT", "0"))
SYNC_WAIT = float(os.getenv("SYNC_WAIT", "25"))  # server waits up to this long, then the client polls
JOB_TIMEOUT = float(os.getenv("JOB_TIMEOUT", "180"))
THINK = tuple(float(x) for x in os.getenv("THINK", "0.5,1.5").split(","))

JOBS: list[dict] = []
SYSTEM: list[dict] = []
META: dict = {}


def _load_images() -> list[tuple[str, bytes, str]]:
    files = []
    if IMAGES_DIR.is_dir():
        for p in sorted(IMAGES_DIR.iterdir()):
            if p.suffix.lower() in {".jpg", ".jpeg", ".png"}:
                mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
                files.append((p.name, p.read_bytes(), mime))
    if not files:
        from PIL import Image, ImageDraw

        for seed in range(5):
            rng = random.Random(seed)
            image = Image.new("RGB", (1240, 1754), "white")  # A4 at 150 dpi
            draw = ImageDraw.Draw(image)
            for y in range(150, 1300, 40):
                draw.line([(100, y), (1140, y)], fill=(150, 150, 150), width=2)
            draw.line([(700 + i * 15, 1500 + rng.randint(-40, 40)) for i in range(25)], fill=(0, 0, 90), width=5)
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=85)
            files.append((f"synthetic_{seed}.jpg", buffer.getvalue(), "image/jpeg"))
    return files


IMAGES = _load_images()


def _users(environment) -> int:
    runner = environment.runner
    return runner.user_count if runner else 0


@events.test_start.add_listener
def _start(environment, **_):
    META.update(host=environment.host, run_name=RUN_NAME, started_at=time.time(), images=len(IMAGES),
                real_images=IMAGES_DIR.is_dir() and any(n for n, _, _ in IMAGES if not n.startswith("synthetic_")),
                steps=os.getenv("STEPS", ""), step_seconds=int(os.getenv("STEP_SECONDS", "60")),
                verify_weight=VERIFY_WEIGHT, think_seconds=THINK, admin_token=bool(os.getenv("ADMIN_TOKEN")))
    print(f"[locust] {len(IMAGES)} images from {IMAGES_DIR} | run {RUN_NAME} | results in {RESULTS_DIR}")
    gevent.spawn(_sample_system, environment)


def _sample_system(environment):
    import requests

    while environment.runner is None or environment.runner.state not in ("stopped", "stopping"):
        try:
            body = requests.get(f"{environment.host}/v1/system", timeout=5).json()
            body.update(t=time.time(), users=_users(environment))
            SYSTEM.append(body)
        except Exception as exc:  # older server without /v1/system: no host metrics, the test still runs
            SYSTEM.append({"t": time.time(), "users": _users(environment), "error": repr(exc)[:120]})
        gevent.sleep(2)


@events.quitting.add_listener
def _write(environment, **_):
    if not JOBS:
        return
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    META["ended_at"] = time.time()
    for name, rows in ((f"{RUN_NAME}_jobs.csv", JOBS), (f"{RUN_NAME}_system.csv", SYSTEM)):
        fields = sorted({k for r in rows for k in r}) if rows else ["t"]
        with open(RESULTS_DIR / name, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
    (RESULTS_DIR / f"{RUN_NAME}_meta.json").write_text(json.dumps(META, indent=2))
    print(f"[locust] wrote {len(JOBS)} jobs and {len(SYSTEM)} system samples to {RESULTS_DIR}")


class SignatureUser(HttpUser):
    wait_time = between(*THINK)

    def on_start(self):
        token = os.getenv("ADMIN_TOKEN")
        if token:
            self.client.headers["X-Admin-Token"] = token

    def _job(self, kind: str, path: str, files: dict) -> None:
        users = _users(self.environment)
        started = time.perf_counter()
        row = {"t_start": time.time(), "users": users, "kind": kind, "ok": False}
        try:
            r = self.client.post(f"{path}{'&' if '?' in path else '?'}wait=true&timeout={SYNC_WAIT}", files=files,
                                 name=f"POST {path.split('?')[0]}")
            row["http_status"] = r.status_code
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            while r.status_code == 202 and time.perf_counter() - started < JOB_TIMEOUT:  # still queued: poll
                gevent.sleep(0.5)
                r = self.client.get(f"/v1/jobs/{body['job_id']}", name="GET /v1/jobs/[id]")
                body = r.json()
                row["http_status"] = r.status_code
            result = body.get("result") or {}
            timings = result.get("timings_ms") or {}
            row.update(ok=r.status_code == 200, status=body.get("status"), error=body.get("error") or body.get("detail"),
                       queue_wait_ms=timings.get("queue_wait"), inference_ms=timings.get("inference"),
                       worker_ms=timings.get("total_worker"), worker_pid=result.get("worker_pid"), retries=result.get("retries"),
                       detections=result.get("signature_count"))
        except Exception as exc:
            row["error"] = repr(exc)[:200]
        e2e = (time.perf_counter() - started) * 1000
        row.update(e2e_ms=round(e2e, 1), t_end=time.time())
        JOBS.append(row)
        events.request.fire(request_type="JOB", name=f"{kind} end-to-end", response_time=e2e, response_length=0,
                            exception=None if row["ok"] else RuntimeError(str(row.get("error") or row.get("http_status"))),
                            context={})

    @task(10)
    def detect(self):
        name, data, mime = random.choice(IMAGES)
        self._job("detect", "/v1/detect", {"file": (name, data, mime)})

    @task(VERIFY_WEIGHT)
    def verify(self):
        (n1, d1, m1), (n2, d2, m2) = random.choice(IMAGES), random.choice(IMAGES)
        self._job("verify", "/v1/verify", {"reference": (n1, d1, m1), "candidate": (n2, d2, m2)})


class StepLoad(LoadTestShape):
    """Active only when STEPS is set, e.g. STEPS=1,5,10,20,40 STEP_SECONDS=90."""

    steps = [int(x) for x in os.getenv("STEPS", "").split(",") if x.strip()]
    step_seconds = int(os.getenv("STEP_SECONDS", "60"))

    def tick(self):
        if not self.steps:
            return None
        index = int(self.get_run_time() // self.step_seconds)
        if index >= len(self.steps):
            return None
        users = self.steps[index]
        return users, users  # spawn rate = users/s, i.e. jump to the step quickly


if not StepLoad.steps:  # without STEPS, use normal -u/-r command line options
    del StepLoad
