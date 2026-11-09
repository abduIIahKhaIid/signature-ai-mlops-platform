# Phase 5 & 6 — EC2 deployment and message-queue test results

**Environment:** AWS EC2 `t3.large` (2 vCPU, 8 GB), ap-southeast-2 (Sydney), Ubuntu, Docker Compose
(`api` FastAPI ×2 uvicorn workers, `worker` Celery prefork concurrency 2, `redis`).
Model pulled from S3 via the instance IAM role (no keys on the server).
**Tested:** 2026-11-10 ~01:20 PKT from a browser client in Pakistan → Sydney (upload time includes that network path).

## Phase 5 — deployment checks
| Check | Result |
|---|---|
| `GET /health` | `ok` |
| `GET /ready` | `ready`, 1 Celery worker node (2 processes) |
| `GET /v1/model` | detector `v20261109T142002Z-8a4d7444` from S3 registry, `last_reload_error: null` |
| Credentials | `Found credentials from IAM Role: SignatureAI-EC2-Role` (worker log) |
| Worker cold start (model cached on volume) | 25.8 s per process at boot; 40.9 s reported after a restart under load |

## Phase 6 — queue behaviour
| # | Test | Result |
|---|---|---|
| 1 | Single async job | `202` → `PENDING` → `STARTED` (2.0 s) → `SUCCESS` (5.8 s); queue wait 30 ms, inference 2.5 s |
| 2 | **20 jobs submitted at once** | 20/20 accepted (`202`), **20/20 SUCCESS, 0 failed, 0 lost**; all done in **21.6 s** (**0.93 images/s**); both worker processes used (pid 9, 10); queue wait min / median / max = 10 ms / 10.1 s / 16.6 s; median inference 1.7 s |
| 3 | Transient failure ×2 (`simulate_failures=2`) | `PENDING → STARTED → RETRY → SUCCESS` in 3.4 s, `retries: 2` |
| 4 | Transient failure ×5 (> `MAX_RETRIES=3`) | `PENDING → RETRY → FAILURE` after 9.5 s, error `TransientError … (attempt 4)`, HTTP 500 |
| 5 | Corrupt image | `FAILURE` → HTTP **422** `InvalidImage`, not retried (bad input) |
| 6 | Wrong content type (`text/plain`) | HTTP **415** at the API, never enqueued |

## Reading the numbers
* The API answers in milliseconds-to-seconds regardless of load (upload time only); the queue absorbs bursts:
  with 20 simultaneous jobs and 2 worker processes, the last job waited ~16.6 s in Redis but none failed.
* Throughput ≈ (worker processes) / (inference time) ≈ 2 / 1.7 s ≈ 1.2 images/s theoretical, 0.93 measured.
  Scaling = more processes/instances (`docker compose up -d --scale worker=N` or bigger instance) — Phase 9 measures this.
* Retries use exponential backoff with jitter (2 s, 4 s, 8 s …), uploads are kept until the job is final.
