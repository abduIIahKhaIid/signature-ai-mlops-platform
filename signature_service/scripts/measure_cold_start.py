"""Measure worker cold start on the deployed docker-compose stack.

  python scripts/measure_cold_start.py --url http://localhost:8000            # warm restart (model cached)
  python scripts/measure_cold_start.py --url http://localhost:8000 --fresh    # true cold start: model cache wiped,
                                                                              # so it includes the S3 download

Reports:
  container_to_ready_s   docker restart -> /ready returns 200 (worker online, model loaded)
  in_worker_model_load_s worker's own measurement (S3 fetch + SHA check + load + warm-up)
  first_request_ms       first /v1/detect after ready
  warm_request_ms        median of the next 5 requests
Run it from the folder that contains docker-compose.yml.
"""
from __future__ import annotations

import argparse
import io
import json
import statistics
import subprocess
import time
from pathlib import Path

import requests


def sh(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def sample_image(path: str | None) -> tuple[str, bytes, str]:
    if path:
        p = Path(path)
        return p.name, p.read_bytes(), "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (1240, 1754), "white")
    ImageDraw.Draw(image).line([(700 + i * 15, 1500 + (i % 5) * 9) for i in range(25)], fill=(0, 0, 90), width=5)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")
    return "synthetic.jpg", buffer.getvalue(), "image/jpeg"


def detect_ms(url: str, image) -> float:
    started = time.perf_counter()
    r = requests.post(f"{url}/v1/detect?wait=true&timeout=60", files={"file": image}, timeout=90)
    r.raise_for_status()
    return (time.perf_counter() - started) * 1000


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--fresh", action="store_true", help="delete the cached model volume first")
    parser.add_argument("--image", help="path to a real document image")
    parser.add_argument("--timeout", type=float, default=600)
    args = parser.parse_args()
    image = sample_image(args.image)

    sh("docker", "compose", "stop", "worker")
    if args.fresh:
        sh("docker", "compose", "rm", "-f", "worker")
        for volume in sh("docker", "volume", "ls", "-q", "--filter", "name=model-cache").split():
            sh("docker", "volume", "rm", volume)

    started = time.perf_counter()
    sh("docker", "compose", "up", "-d", "worker")
    while True:
        try:
            if requests.get(f"{args.url}/ready", timeout=3).status_code == 200:
                break
        except requests.RequestException:
            pass
        if time.perf_counter() - started > args.timeout:
            raise SystemExit("worker did not become ready in time; check `docker compose logs worker`")
        time.sleep(0.5)
    ready_s = time.perf_counter() - started

    first_ms = detect_ms(args.url, image)
    warm = [detect_ms(args.url, image) for _ in range(5)]
    info = requests.get(f"{args.url}/v1/model", timeout=30).json().get("result", {})

    report = {
        "mode": "fresh (includes S3 download)" if args.fresh else "warm restart (model cached)",
        "model_version": info.get("detector_version"),
        "container_to_ready_s": round(ready_s, 2),
        "in_worker_model_load_s": info.get("cold_start_seconds"),
        "first_request_ms": round(first_ms, 1),
        "warm_request_ms_median": round(statistics.median(warm), 1),
        "measured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    print(json.dumps(report, indent=2))
    out = Path("loadtest/results")
    out.mkdir(parents=True, exist_ok=True)
    (out / f"cold_start_{'fresh' if args.fresh else 'warm'}.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
