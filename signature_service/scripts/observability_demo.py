"""Send every kind of request the monitoring should show, so each one appears as a trace in Logfire.

  python scripts/observability_demo.py --url http://13.236.244.226:8000 --admin-token <PIPELINE_ADMIN_TOKEN>

Scenarios (each prints its job id, final status and timings; search the job id in Logfire to open its trace):
  1  normal detection                 FastAPI request -> Redis -> Celery task -> model_inference span
  2  signature verification           two images, detection + similarity in one task
  3  burst of N jobs at once          queue wait grows (queue_wait_ms on the spans), CPU/RAM rise
  4  retry then success               simulate_failures=2: RETRY, RETRY, SUCCESS   (needs ALLOW_FAILURE_SIMULATION=true)
  5  retries exhausted                simulate_failures=5 > MAX_RETRIES: FAILURE  (needs ALLOW_FAILURE_SIMULATION=true)
  6  corrupt image                    worker raises InvalidImage -> HTTP 422, not retried
  7  wrong file type                  rejected by the API with 415, never queued
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import time

import requests


def page(seed: int = 0) -> bytes:
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    for y in range(150, 1300, 40):
        draw.line([(100, y), (1140, y)], fill=(150, 150, 150), width=2)
    draw.line([(700 + i * 15, 1500 + ((i * 7 + seed) % 9) * 6) for i in range(25)], fill=(0, 0, 90), width=5)
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


class Client:
    def __init__(self, url: str, token: str | None, image: bytes):
        self.url = url.rstrip("/")
        self.s = requests.Session()
        if token:
            self.s.headers["X-Admin-Token"] = token  # load-test / demo traffic is not rate limited
        self.image = image

    def job(self, path: str, files: dict, timeout: float = 120) -> dict:
        t0 = time.perf_counter()
        r = self.s.post(f"{self.url}{path}", files=files, timeout=60)
        if r.status_code not in (200, 202):
            return {"http": r.status_code, "status": "REJECTED", "detail": r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else r.text[:120],
                    "seconds": time.perf_counter() - t0}
        body = r.json()
        seen = [body["status"]]
        while body["status"] not in ("SUCCESS", "FAILURE") and time.perf_counter() - t0 < timeout:
            time.sleep(0.3)
            r = self.s.get(f"{self.url}/v1/jobs/{body['job_id']}", timeout=30)
            body = r.json()
            if body["status"] != seen[-1]:
                seen.append(body["status"])
        res = body.get("result") or {}
        return {"http": r.status_code, "job_id": body.get("job_id"), "status": body["status"], "path": " -> ".join(seen),
                "timings": res.get("timings_ms"), "retries": res.get("retries"), "error": body.get("error"), "seconds": time.perf_counter() - t0}


def show(title: str, out: dict) -> None:
    print(f"\n== {title}")
    for k in ("job_id", "status", "path", "http", "retries", "timings", "error", "detail"):
        if out.get(k) not in (None, ""):
            print(f"   {k:8}: {out[k]}")
    print(f"   took    : {out['seconds']:.2f} s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--admin-token")
    ap.add_argument("--burst", type=int, default=12)
    ap.add_argument("--image", help="a real document image (JPG/PNG); a synthetic page is used otherwise")
    args = ap.parse_args()
    image = open(args.image, "rb").read() if args.image else page()
    mime = "image/png" if (args.image or "").lower().endswith(".png") else "image/jpeg"
    c = Client(args.url, args.admin_token, image)
    doc = lambda: {"file": ("document.jpg", image, mime)}  # noqa: E731

    print(f"Target {args.url}  |  model: {requests.get(args.url + '/v1/model', timeout=30).json().get('result', {}).get('detector_version')}")
    show("1. normal detection", c.job("/v1/detect", doc()))
    show("2. signature verification", c.job("/v1/verify", {"reference": ("a.jpg", image, mime), "candidate": ("b.jpg", page(3), "image/jpeg")}))

    print(f"\n== 3. burst of {args.burst} jobs at the same moment")
    with cf.ThreadPoolExecutor(args.burst) as pool:
        results = list(pool.map(lambda _: c.job("/v1/detect", doc()), range(args.burst)))
    waits = sorted((r.get("timings") or {}).get("queue_wait") or 0 for r in results)
    ok = sum(r["status"] == "SUCCESS" for r in results)
    print(f"   {ok}/{len(results)} succeeded | queue wait min {waits[0]:.0f} ms, median {waits[len(waits) // 2]:.0f} ms, max {waits[-1]:.0f} ms"
          f" | slowest job {max(r['seconds'] for r in results):.1f} s")

    retry = c.job("/v1/detect?simulate_failures=2", doc())
    show("4. transient failure x2, then success (RETRY -> SUCCESS)", retry)
    if retry.get("http") == 403:
        print("   -> enable ALLOW_FAILURE_SIMULATION=true in the server .env for scenarios 4 and 5 (and turn it off afterwards)")
    else:
        show("5. transient failure x5 > MAX_RETRIES (ends in FAILURE)", c.job("/v1/detect?simulate_failures=5", doc()))
    show("6. corrupt image (InvalidImage, 422, not retried)", c.job("/v1/detect", {"file": ("broken.png", b"\x89PNG\r\n\x1a\nthis is not an image", "image/png")}))
    show("7. wrong file type (415 at the API, never queued)", c.job("/v1/detect", {"file": ("notes.txt", b"hello", "text/plain")}))
    print("\nOpen Logfire -> Live, filter by service signature-service-api / signature-service-worker, or search a job id above.")


if __name__ == "__main__":
    main()
