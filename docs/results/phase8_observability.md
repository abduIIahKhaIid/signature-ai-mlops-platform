# Phase 8: monitoring with Logfire (logs, traces, performance)

Logfire (Pydantic, built on OpenTelemetry) is the single place for logs, traces and host metrics.
Grafana is not needed: Logfire gives live traces, SQL over every span and log line, and dashboards.

## What is instrumented

| Where | What Logfire receives | Code |
|---|---|---|
| FastAPI (`api` container) | one span per HTTP request: route, status code, duration | `observability.instrument_fastapi` |
| Redis | every Redis command from API and workers | `logfire.instrument_redis()` |
| Celery | task publish (API) and task run (worker), linked into **one trace** per request | `logfire.instrument_celery()` |
| Worker: `detect` / `verify` span | `model_version`, `retries`, `queue_wait_ms` | `app/tasks.py` |
| Worker: `model_inference` span | the model call alone: `model_version`, `image_width`, `image_height` | `app/tasks.py` |
| Worker: `detect done` log | `inference_ms`, `queue_wait_ms`, `detections` as queryable fields | `app/tasks.py` |
| Retries and failures | `RETRY` spans with the exception, final `FAILURE` with traceback; bad input (`InvalidImage`) is not retried | Celery instrumentation |
| Host metrics | CPU %, memory, swap of each container (Logfire "Basic System Metrics") | `logfire.instrument_system_metrics(base="basic")` |
| Retraining orchestrator | `pipeline.check` / `pipeline.tick` tasks and their decisions | `pipeline` container |

One detection request therefore shows up as a single trace:

```
POST /v1/detect (api)  ──publish──▶  run signature.detect (worker)
                                        ├── detect            queue_wait_ms=…
                                        │     └── model_inference
                                        └── detect done       inference_ms=…  detections=…
```

## 1. Rotate the token (required)

The first token was committed to the public repository (`deploy/ec2_user_data.sh`, since removed). Anyone could send
data into the project with it, so it must be revoked:

1. logfire.pydantic.dev → project → **Settings → Write tokens** → delete the old token (starts with `pylf_v1_us_bybRhj`).
2. **New write token** → copy it.
3. On EC2:
   ```bash
   cd ~/app/signature_service
   nano .env                         # LOGFIRE_TOKEN=<new token>
   docker compose up -d              # recreates the containers that use it
   docker compose logs api worker | grep -i "logfire enabled"
   ```
The token lives only in the server's `.env` (never in git).

## 2. Produce the evidence

```bash
# on EC2, for the retry / failure scenarios only (switch it off again afterwards)
cd ~/app/signature_service
grep -q '^ALLOW_FAILURE_SIMULATION=' .env || echo 'ALLOW_FAILURE_SIMULATION=false' >> .env
sed -i 's/^ALLOW_FAILURE_SIMULATION=.*/ALLOW_FAILURE_SIMULATION=true/' .env && docker compose up -d

# on the laptop (signature_service folder)
python scripts/observability_demo.py --url http://13.236.244.226:8000 --admin-token <PIPELINE_ADMIN_TOKEN>

# on EC2 afterwards
sed -i 's/^ALLOW_FAILURE_SIMULATION=.*/ALLOW_FAILURE_SIMULATION=false/' .env && docker compose up -d
```
The script sends a normal detection, a verification, a burst of 12 simultaneous jobs, a retry that succeeds, a retry
that runs out of attempts, a corrupt image and a wrong file type, and prints every job id. The Locust stress test
(phase 9) is a second, heavier source of traces and CPU/RAM load.

## 3. Screenshots

Save them in `docs/images/` with exactly these names, so the links below work.

| # | Logfire view | What it proves | File |
|---|---|---|---|
| 1 | Live → open a `POST /v1/detect` trace | one request followed API → Redis → Celery → `model_inference` | [`logfire_trace_detect.png`](../images/logfire_trace_detect.png) |
| 2 | The `detect` span's attributes | `queue_wait_ms` and `model_version` on every job | [`logfire_queue_wait.png`](../images/logfire_queue_wait.png) |
| 3 | Trace of scenario 4 | `RETRY` → `RETRY` → `SUCCESS`, with the exception on each retry | [`logfire_retry.png`](../images/logfire_retry.png) |
| 4 | Trace of scenario 5 or 6 | final `FAILURE` with traceback (5), or `InvalidImage` not retried (6) | [`logfire_failure.png`](../images/logfire_failure.png) |
| 5 | Dashboards → Basic System Metrics, during the stress test | CPU and memory of API and worker containers under load | [`logfire_system_metrics.png`](../images/logfire_system_metrics.png) |
| 6 | Explore → query A below | p50 / p95 latency per span from real traffic | [`logfire_sql_latency.png`](../images/logfire_sql_latency.png) |


## 4. Queries (Logfire → Explore, SQL)

A. Latency per span over the last hour:
```sql
SELECT service_name, span_name, count(*) AS spans,
       round(approx_percentile_cont(duration * 1000, 0.5)) AS p50_ms,
       round(approx_percentile_cont(duration * 1000, 0.95)) AS p95_ms
FROM records
WHERE (span_name IN ('model_inference', 'detect', 'verify') OR span_name LIKE 'POST /v1/%')
  AND start_timestamp > now() - interval '1 hour'
GROUP BY service_name, span_name
ORDER BY p95_ms DESC
```

B. Queue wait and inference per minute (how the queue absorbs a burst):
```sql
SELECT date_trunc('minute', start_timestamp) AS minute, count(*) AS jobs,
       round(approx_percentile_cont(CAST(attributes->>'queue_wait_ms' AS DOUBLE), 0.95)) AS queue_wait_p95_ms,
       round(approx_percentile_cont(CAST(attributes->>'inference_ms' AS DOUBLE), 0.5)) AS inference_p50_ms
FROM records
WHERE message = 'detect done' AND start_timestamp > now() - interval '3 hours'
GROUP BY minute ORDER BY minute
```

C. Errors and retries:
```sql
SELECT span_name, level, count(*) AS n, max(exception_type) AS example
FROM records
WHERE (is_exception OR level >= 'warn') AND start_timestamp > now() - interval '3 hours'
GROUP BY span_name, level ORDER BY n DESC
```
If a column name differs in your Logfire version, the same information is in the Explore UI filters
(span name, attributes, level).

## Without Logfire

Everything still logs to stdout with the same fields (`docker compose logs -f worker` shows
`detect ok job=… queue_wait_ms=… inference_ms=… retries=…`), and every API result carries `timings_ms`.
`GET /v1/system` returns host CPU, RAM and the number of jobs waiting in Redis; the stress test samples it every 2 s.
