# SignatureAI inference service

FastAPI + Redis + Celery service that serves the RT-DETRv2 signature detector trained in
`notebooks/01_detection_training_colab.ipynb` (and retrained by `pipeline/`), plus a signature similarity
endpoint (Siamese ResNet18 from `notebooks/03_similarity_same_dataset_kaggle.ipynb`; first CEDAR version:
`notebooks/archive/02_similarity_siamese_cedar_kaggle.ipynb`). No Ultralytics code: RT-DETRv2 via Hugging Face `transformers` (Apache-2.0),
ResNet18 via `torchvision` (BSD-3).

```
client ──HTTP──▶ FastAPI (api) ──job id──▶ Redis (broker) ──▶ Celery worker(s) ──▶ result ──▶ Redis (backend)
                   │  stores upload                               │ loads model once per process
                   ▼                                               ▼
           shared volume / S3 uploads                S3 model registry (versions/ + aliases/)
                                                        written by the training notebook
```

* The **API never runs the model**. It validates and stores the upload, enqueues a job and returns
  `202 + job_id`, or waits up to `timeout` seconds when called with `?wait=true`.
* **Workers** pull the model from S3 at start-up (`aliases/<MODEL_ALIAS>.json` → `versions/<v>/artifact.zip`),
  verify the SHA-256 from `manifest.json`, cache it in the `model-cache` volume and warm it up.
  Weights are never in git or in the docker image.
* **Hot reload / auto-deploy**: every `MODEL_POLL_SECONDS` each worker re-reads both configured aliases
  (`MODEL_ALIAS` and `SIMILARITY_S3_ALIAS`). When an approved alias moves, workers download the new detector
  or Siamese model, verify its SHA-256, fully load and smoke-test it, and only then atomically swap it in.
  If anything fails they keep serving the old model and expose the error through `/v1/model` and the
  "Models on the workers" card on `/pipeline`. A release that failed is not downloaded again for
  `FAILED_RELEASE_RETRY_SECONDS` (default 1 h) unless the alias moves to another release, and a similarity model that
  cannot be loaded at start-up never stops the worker: detection keeps working and hot reload repairs it later.
* Jobs survive worker crashes (`acks_late` + `reject_on_worker_lost`); results expire after `RESULT_TTL_SECONDS`.
* Job lifecycle: `PENDING → STARTED → SUCCESS`, or `RETRY` (transient network/S3 errors, exponential backoff,
  up to `MAX_RETRIES`) and `FAILURE` (bad input is not retried). Uploads are kept while a retry is pending and
  deleted when the job is final. Every result reports `timings_ms.queue_wait` (enqueue → worker start),
  `inference`, `total_worker` and `retries`; the same values are on the Logfire spans.
* Retry demo: set `ALLOW_FAILURE_SIMULATION=true`, then `POST /v1/detect?simulate_failures=2` shows
  `RETRY → RETRY → SUCCESS`; `simulate_failures=5` (more than `MAX_RETRIES`) ends in `FAILURE`.

## Web app

The API also serves a React web app (`web/`, built into the API image by `docker/api.Dockerfile`):

| Page | What it does |
|---|---|
| `/` **Detect** | Upload or paste a document image: signature boxes drawn on the page, confidence per signature with a live minimum-confidence slider, close-up crops, the request's path (upload → queue → worker → result) with measured times, download of the marked image or JSON |
| `/verify` **Verify** | Reference + questioned signature (cropped or whole documents): similarity score, match line, verdict, which region was compared |
| `/pipeline` **Pipeline** | Retraining dashboard: live run, steps, dataset cleaning, training curves, evaluation and deployment gate, event log, run history, admin buttons |

It only uses the public API (`/v1/detect`, `/v1/verify`, `/v1/jobs/{id}`, `/v1/model`, `/ready`, `/v1/pipeline/*`).
Develop it against any running API, e.g. the EC2 server:

```bash
cd signature_service/web
npm install
API_TARGET=http://13.236.244.226:8000 npm run dev     # http://localhost:5173
npm run build                                        # type check + production build (CI runs this too)
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/detect` | `file` = document image → signature boxes (`?wait=true`, `?threshold=0.5`) |
| POST | `/v1/verify` | `reference` + `candidate` images → similarity score (detects + crops first; `?crop=false` to skip) |
| GET | `/v1/jobs/{id}` | status `PENDING/STARTED/SUCCESS/FAILURE` + result |
| GET | `/v1/model` | model version served, cold-start time, hot-reload status |
| GET | `/health` | liveness of the API |
| GET | `/ready` | Redis reachable **and** ≥1 worker online |
| POST | `/webhooks/huggingface` | HF dataset update → retraining on EC2 + Kaggle (see `docs/setup/retraining_pipeline.md`) |
| GET | `/pipeline` | live retraining dashboard (`/v1/pipeline/state` = its JSON) |
| POST | `/v1/pipeline/check` | check the HF repo now, `?force=true` = retrain anyway (header `X-Admin-Token`) |

Interactive docs: `http://<host>:8000/docs`.

```bash
curl -F "file=@doc.jpg;type=image/jpeg" "http://localhost:8000/v1/detect?wait=true"
curl -F "reference=@a.png;type=image/png" -F "candidate=@b.png;type=image/png" "http://localhost:8000/v1/verify?wait=true"
```

Status codes: `200` done, `202` still running (poll `poll_url`), `415` unsupported type,
`413` too large, `422` not a valid image, `429` too many jobs from one IP (`RATE_LIMIT_PER_MINUTE`, default 30/min),
`500` worker error. Responses (JSON and the web app) are gzip-compressed.

## Run locally (Docker)

```bash
cp .env.example .env        # fill in bucket, region, AWS read-only key (or MODEL_SOURCE=local)
docker compose up -d --build
docker compose logs -f worker    # wait for "models ready in ...s"
curl localhost:8000/ready
docker compose up -d --scale worker=3   # more capacity
```

`MODEL_ALIAS=production` only works after the notebook's manual promotion cell has written
`aliases/production.json`; until then use `MODEL_ALIAS=latest` or pin `MODEL_VERSION=v…`.

## Deploy on AWS EC2

* Create the server once: [`docs/setup/deploy_ec2.md`](../docs/setup/deploy_ec2.md).
* After that, every push to `main` is deployed automatically by GitHub Actions through AWS SSM:
  [`docs/setup/cicd_github_secrets.md`](../docs/setup/cicd_github_secrets.md). Do not edit code on the server.
* Tuning: `WORKER_CONCURRENCY` ≈ number of vCPUs and `TORCH_THREADS=1` for throughput, or concurrency 1 and
  `TORCH_THREADS`=vCPUs for the lowest single-request latency. Measure both.
* Multi-host (ECS / several EC2 workers): set `STORAGE_BACKEND=s3` so API and workers share uploads,
  and point all of them at a managed Redis (ElastiCache).

## Observability (Logfire)

Set `LOGFIRE_TOKEN` (Logfire project → write token). FastAPI requests, Celery tasks, Redis calls and
custom spans (`load_models`, `detect`, `verify` with the model version) are traced, so one request can
be followed from HTTP → queue → worker → result. Without a token everything logs to stdout.

## Stress test and cold start

Full report: [`docs/results/phase9_stress_test.md`](../docs/results/phase9_stress_test.md) (generated, see below).

```bash
pip install locust requests pillow matplotlib
# 1) load test from your laptop: 1 -> 5 -> 10 -> 20 -> 40 users, 90 s each (~8 min)
ADMIN_TOKEN=<PIPELINE_ADMIN_TOKEN> STEPS=1,5,10,20,40 STEP_SECONDS=90 RUN_NAME=ec2_t3large \
  locust -f loadtest/locustfile.py --host http://13.236.244.226:8000 --headless \
  --csv loadtest/results/ec2_t3large --html loadtest/results/ec2_t3large.html
# 2) cold start, ON the EC2 host (stops the worker for about a minute)
python3 scripts/measure_cold_start.py --fresh      # model cache wiped: includes the S3 download
python3 scripts/measure_cold_start.py              # warm restart, model cached
# 3) copy loadtest/results/cold_start_*.json from EC2 next to the run files, then build the report
python loadtest/report.py --run loadtest/results/ec2_t3large
```

The locustfile records every job (end-to-end time, queue wait and inference measured by the worker, worker process)
and samples `GET /v1/system` (host CPU, RAM, jobs waiting in Redis) every 2 s. `report.py` turns that into per-step
throughput, p50/p95/p99, failure rate, queue wait, inference, CPU/RAM, the maximum stable concurrency, charts in
`docs/images/` and a copy of the raw files in `docs/results/stress_data/`.

## Tests

```bash
pip install -r requirements-dev.txt   # also needs redis-server on PATH for the end-to-end tests
pytest -q
```

`tests/test_e2e.py` starts a real Redis, a real Celery worker process and an S3 registry (moto
server) with a tiny randomly initialised RT-DETRv2, then checks sync/async detection, input
validation, upload clean-up, similarity, `/v1/model`, and **hot reload when the alias moves**.
`tests/test_registry.py` covers alias validation, caching, SHA-256 mismatch and zip-slip rejection. The end-to-end
suite moves both detector and similarity aliases and verifies that a broken similarity release cannot replace the
working model.

## Known limitations

* Similarity quality depends on the dataset recorded in that model version's report. Clean signature pairs and
  detector-cropped real documents can be different domains, so validate FAR/FRR on production-like crops before
  promoting an alias ([`docs/results/phase7_similarity_results.md`](../docs/results/phase7_similarity_results.md)).
* CPU inference. Export to ONNX / quantise if latency targets are not met.
* `STORAGE_BACKEND=local` assumes API and workers share one host.
