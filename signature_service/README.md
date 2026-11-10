# SignatureAI inference service

FastAPI + Redis + Celery service that serves the RT-DETRv2 signature detector trained in
`notebooks/01_detection_training_colab.ipynb` (and retrained by `pipeline/`), plus a signature similarity
endpoint (Siamese ResNet18 from `notebooks/02_similarity_siamese_kaggle.ipynb`). No Ultralytics code: RT-DETRv2 via Hugging Face `transformers` (Apache-2.0),
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
* **Hot reload / auto-deploy**: every `MODEL_POLL_SECONDS` each worker re-reads the alias. When the
  retraining pipeline publishes a new version and moves the alias, workers download it, load it,
  and only then swap it in. If anything fails they keep serving the old model.
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

```bash
pip install locust requests pillow
# put ~20 real test-split images in loadtest/images/
ADMIN_TOKEN=<PIPELINE_ADMIN_TOKEN> STEPS=1,5,10,20,40 STEP_SECONDS=60 locust -f loadtest/locustfile.py \
    --host http://<server>:8000 --headless --csv loadtest/results/run1 --html loadtest/results/run1.html
ADMIN_TOKEN=<PIPELINE_ADMIN_TOKEN> MODE=async locust -f loadtest/locustfile.py --host http://<server>:8000 --headless -u 20 -r 5 -t 3m

python scripts/measure_cold_start.py --url http://localhost:8000 --fresh   # includes S3 download
python scripts/measure_cold_start.py --url http://localhost:8000           # warm restart
```

Report for each step: requests/s, p50/p95/p99 latency and failure rate. Capacity = the highest
concurrency where p95 stays under your target (e.g. 2 s) with 0 % failures; repeat with
`--scale worker=N` to show horizontal scaling.

## Tests

```bash
pip install -r requirements-dev.txt   # also needs redis-server on PATH for the end-to-end tests
pytest -q
```

`tests/test_e2e.py` starts a real Redis, a real Celery worker process and an S3 registry (moto
server) with a tiny randomly initialised RT-DETRv2, then checks sync/async detection, input
validation, upload clean-up, similarity, `/v1/model`, and **hot reload when the alias moves**.
`tests/test_registry.py` covers alias resolution, caching, SHA-256 mismatch and zip-slip rejection.

## Known limitations

* `/v1/verify` uses the Siamese ResNet18 trained on CEDAR (clean scans). Signatures cropped from real documents are a
  different domain, so expect lower accuracy until it is trained on in-domain pairs
  ([`docs/results/phase7_similarity_results.md`](../docs/results/phase7_similarity_results.md)).
* CPU inference. Export to ONNX / quantise if latency targets are not met.
* `STORAGE_BACKEND=local` assumes API and workers share one host.
