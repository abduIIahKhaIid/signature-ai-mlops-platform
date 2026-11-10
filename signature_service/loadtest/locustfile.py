"""Stress test for the deployed platform.

Examples (run from signature_service/):
  # Interactive UI at http://localhost:8089
  locust -f loadtest/locustfile.py --host http://<server>:8000

  # Headless step test: 1 -> 5 -> 10 -> 20 -> 40 concurrent users, CSV results for the report
  ADMIN_TOKEN=<PIPELINE_ADMIN_TOKEN> STEPS=1,5,10,20,40 STEP_SECONDS=60 locust -f loadtest/locustfile.py \
      --host http://<server>:8000 --headless --csv loadtest/results/run1 --html loadtest/results/run1.html
  (without ADMIN_TOKEN the per-IP rate limit answers 429 once you exceed RATE_LIMIT_PER_MINUTE)

Use real document images: put some test-split JPG/PNGs in loadtest/images/ (or set IMAGES_DIR).
If the folder is empty, synthetic images are generated.
"""
from __future__ import annotations

import io
import os
import random
import time
from pathlib import Path

from locust import HttpUser, LoadTestShape, between, events, task

IMAGES_DIR = Path(os.getenv("IMAGES_DIR", Path(__file__).parent / "images"))
MODE = os.getenv("MODE", "sync")  # sync: ?wait=true | async: submit then poll /v1/jobs


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


@events.init.add_listener
def _announce(environment, **_):
    print(f"[locust] {len(IMAGES)} test images from {IMAGES_DIR} | mode={MODE}")


class SignatureUser(HttpUser):
    wait_time = between(0.5, 1.5)

    def on_start(self):
        # The API limits detect/verify jobs per IP (RATE_LIMIT_PER_MINUTE). A stress test sends far more from one
        # machine, so it identifies itself with the admin token: ADMIN_TOKEN=<PIPELINE_ADMIN_TOKEN> locust ...
        token = os.getenv("ADMIN_TOKEN")
        if token:
            self.client.headers["X-Admin-Token"] = token

    @task(9)
    def detect(self):
        name, data, mime = random.choice(IMAGES)
        if MODE == "async":
            self._detect_async(name, data, mime)
            return
        with self.client.post("/v1/detect?wait=true&timeout=60", files={"file": (name, data, mime)},
                              name="/v1/detect (sync)", catch_response=True) as r:
            if r.status_code != 200:
                r.failure(f"{r.status_code}: {r.text[:200]}")

    def _detect_async(self, name, data, mime):
        started = time.perf_counter()
        r = self.client.post("/v1/detect", files={"file": (name, data, mime)}, name="/v1/detect (submit)")
        if r.status_code not in (200, 202):
            return
        job_id = r.json()["job_id"]
        while time.perf_counter() - started < 120:
            body = self.client.get(f"/v1/jobs/{job_id}", name="/v1/jobs/[id]").json()
            if body["status"] in {"SUCCESS", "FAILURE"}:
                events.request.fire(request_type="JOB", name="detect end-to-end",
                                    response_time=(time.perf_counter() - started) * 1000,
                                    response_length=0, exception=None if body["status"] == "SUCCESS"
                                    else RuntimeError(body.get("error")))
                return
            time.sleep(0.25)
        events.request.fire(request_type="JOB", name="detect end-to-end", response_time=120000,
                            response_length=0, exception=TimeoutError("job not finished in 120 s"))

    @task(1)
    def verify(self):
        (n1, d1, m1), (n2, d2, m2) = random.choice(IMAGES), random.choice(IMAGES)
        with self.client.post("/v1/verify?wait=true&timeout=60",
                              files={"reference": (n1, d1, m1), "candidate": (n2, d2, m2)},
                              name="/v1/verify (sync)", catch_response=True) as r:
            if r.status_code != 200:
                r.failure(f"{r.status_code}: {r.text[:200]}")


class StepLoad(LoadTestShape):
    """Active only when STEPS is set, e.g. STEPS=1,5,10,20,40 STEP_SECONDS=60."""

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
