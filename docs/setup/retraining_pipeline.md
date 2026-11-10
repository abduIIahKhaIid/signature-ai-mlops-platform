# Phase 10: Continuous training (EC2 orchestrator + Kaggle GPU + live dashboard)

```
 Dataset dashboard ──publish ZIP──▶ Hugging Face dataset repo (new commit)
                                        │  webhook  (X-Webhook-Secret)
                                        ▼
 EC2 ─ API  POST /webhooks/huggingface ── verify secret · filter · debounce ──▶ Redis queue "pipeline"
     │                                                                         │
     ├─ pipeline worker (Celery, 1 process + beat)  ◀──────────────────────────┘   (+ fallback HF poll, + dashboard button)
     │    1. Is there a .zip in the repo?                       no  → "no dataset", nothing runs
     │    2. Newest ZIP's SHA-256 (from HF metadata, no download) already trained?   yes → "already trained", skip
     │    3. Build the notebook PINNED to commit + file + SHA-256 → kaggle kernels push (T4)
     │    4. Every few seconds: Kaggle status + live progress JSON from S3 → Redis → dashboard
     │    5. Result: gate deployed → wait until the inference workers serve the new version
     │
     └─ GET /pipeline  live dashboard (phases, cleaning report, epochs, gate, event log, decisions, history)

 Kaggle T4 ─ pipeline/train_pipeline.ipynb
     download pinned ZIP → verify SHA-256 → clean (invalid images, bad boxes, exact dups, train↔test leaks, near dups)
     → leakage gate + split → FINE-TUNE the served model (S3 alias) → Comet → test eval → threshold calibration
     → immutable S3 version → GATE (floor + no regression vs served model, same test set) → move alias if passed
     → writes pipeline_runs/datasets/<sha256>.json  ("this dataset is trained")  ← metadata only
```

**No dataset is ever stored in AWS.** The ZIP goes Hugging Face → Kaggle only. S3 holds models, small
JSON run records and the "trained" markers (SHA-256 → model version).

**Fine-tune, not from scratch.** Every run starts from the model the API serves now (`INIT_FROM='latest'`).
The very first model was itself fine-tuned from the Apache-2.0 COCO checkpoint `PekingU/rtdetr_v2_r18vd`.

## Duplicate protection (what will NOT start a training)
| Situation | Decision on the dashboard |
|---|---|
| Webhook but the repo has no `.zip` | `No dataset ZIP` |
| Same ZIP content uploaded again (any file name, any commit) | `Already trained` (shows which model) |
| New upload while a run is in progress | `Queued after run`: re-checked when the run ends |
| Several webhooks within 45 s (one upload = several commits) | one check |
| Same dataset failed twice | `Not retried` (use **Retrain anyway**) |
| Kaggle / HF / S3 not configured or unreachable | `Blocked` / `Error`, never a blind GPU run |

## One-time setup on EC2 (≈ 20 min)

### 1. Kaggle
1. kaggle.com → Settings → **Phone verification** (needed for GPU + internet).
2. Settings → API → **Create New Token** → `kaggle.json` gives `username` and `key`.

### 2. `signature_service/.env` on EC2 (add these lines; see `.env.example`)
```
HF_DATASET_REPO=mabdullahkhalid/Signature_Dataset_Detection
HF_WEBHOOK_SECRET=<long random string>
HF_TOKEN=<HF read token: the repo is private>
KAGGLE_USERNAME=<kaggle username>
KAGGLE_KEY=<key from kaggle.json>
PIPELINE_ADMIN_TOKEN=<another long random string>
RETRAIN_MODE=smoke          # first demo; switch to full for real retraining

# Comet: the dashboard reads the experiment, and the Kaggle secrets are synced from these before every run
COMET_API_KEY=<key from comet.com → Account settings → API keys>
COMET_WORKSPACE=abdullah-khalid
NOTEBOOK_AWS_ACCESS_KEY_ID=<signatureai-colab-uploader access key>
NOTEBOOK_AWS_SECRET_ACCESS_KEY=<its secret>
NOTEBOOK_AWS_REGION=ap-southeast-2

# Optional alerts
ALERT_WEBHOOK_URL=<Slack or Discord incoming webhook>
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=<gmail address>
SMTP_PASSWORD=<Gmail app password>
ALERT_EMAIL_TO=<where to send>
```
Then `docker compose up -d --build` (starts the new `pipeline` service too).

When `COMET_API_KEY`, `HF_TOKEN` and both `NOTEBOOK_AWS_*` keys are set, the orchestrator re-uploads the Kaggle
secrets dataset before every run, so `.env` is the only place to change a key. Step 3 is then not needed.
Before any GPU time is used, the key is checked against Comet. A wrong key or a workspace that does not belong to
the key blocks the run with a clear message in "Why runs started or not".

### 3. Kaggle secrets dataset (only if you do not set the keys in step 2)
The notebook needs Comet + S3 write keys + the HF token. They live in a **private** Kaggle dataset
`<kaggle-user>/signatureai-pipeline-secrets`. Create it once from the EC2 instance:
```bash
cd ~/app/signature_service
nano pipeline-secrets.env      # COMET_API_KEY=, COMET_WORKSPACE=, AWS_ACCESS_KEY_ID=, AWS_SECRET_ACCESS_KEY=,
                               # AWS_REGION=ap-southeast-2, AWS_S3_BUCKET=signatureai-df-detr-models, HF_TOKEN=
chmod 600 pipeline-secrets.env
docker compose run --rm -v "$PWD/pipeline-secrets.env:/tmp/s.env:ro" pipeline \
  sh -c 'set -a; . /tmp/s.env; set +a; python /srv/pipeline/kaggle_job.py secrets --dataset "$KAGGLE_USERNAME/signatureai-pipeline-secrets"'
rm pipeline-secrets.env
```
Use the `signatureai-colab-uploader` key (read/write on `signatureai/detection/*` only).

### 4. Open the API port for Hugging Face
EC2 → Security group → inbound rule **TCP 8000 from 0.0.0.0/0** (HF calls from the internet).
Anyone can read the dashboard. Its buttons (check, retrain, stop, roll back, alert toggles) need `PIPELINE_ADMIN_TOKEN`.

### 4b. IAM role of the EC2 instance
Stop and Roll back write to S3. Update the instance role with `signature_service/deploy/iam-ec2-role-policy.json`
(statement `PipelineDashboardActions`: `s3:PutObject` on `aliases/*` and `pipeline_runs/control/*` only).

### 5. Hugging Face webhook
huggingface.co → Settings → **Webhooks** → Add:
* Target repositories: dataset `mabdullahkhalid/Signature_Dataset_Detection`
* URL: `http://<EC2-IP>:8000/webhooks/huggingface`
* Secret: the same value as `HF_WEBHOOK_SECRET`
* Triggers: **Repo update**

If HF refuses an `http://` URL, use HTTPS through Caddy. Open ports 80 and 443, set `PUBLIC_HOST=<ip-with-dashes>.sslip.io`
in `.env`, run `docker compose --profile https up -d https`, and use `https://<ip-with-dashes>.sslip.io/webhooks/huggingface`.
Even without any webhook, the fallback poll (`PIPELINE_POLL_MINUTES=30`) finds new uploads.

## Using it
* Dashboard: `http://<EC2-IP>:8000/pipeline`
* Upload a reviewed dataset ZIP to the HF repo. Within a minute a run appears and every phase updates live.
* **Check for new data**: same as a webhook. **Retrain anyway**: retrains the newest ZIP even if it was trained.
* **Stop training**: available once the Kaggle job is submitted and until the gate starts. EC2 writes
  `pipeline_runs/control/<run>.json`; the notebook reads it every 20 s and stops. Nothing is deployed, no failure is
  counted, and the dataset is not marked as trained, so it can run again.
* **Roll back**: points the alias to `previous_version` from `aliases/latest.json` (after checking that model's
  manifest). Workers switch within `MODEL_POLL_SECONDS`. Nothing is deleted.
* **Comet panel**: metrics, parameters, console output and files of the run's experiment, read from the Comet API.
* **Notebook output**: the last 150 lines the Kaggle notebook printed, sent with the heartbeat.
* **Alerts**: email on deploy / reject / fail / stop, Slack or Discord on deploy / fail / stop, and a stuck-run alert
  when no heartbeat arrives for `PIPELINE_STUCK_MINUTES`.
* Also shown: estimated finish time (median step times of earlier runs), Kaggle GPU quota, dataset diff against the
  last trained dataset, model lineage, decision table, admin audit in the event log, and run comparison.
* Results: Comet experiment, S3 `versions/<v>/`, `pipeline_runs/<v>.json`, and `GET /v1/model` showing the new version.

## Modes
| Mode | What | Time on Kaggle T4 |
|---|---|---|
| `smoke` | fine-tune, 2,000 train / 500 val images, 1 epoch, full test set | ≈ 35–50 min incl. download + cleaning |
| `full` | fine-tune on the whole dataset, up to 8 epochs, early stopping | several hours (Kaggle limit 12 h) |

## Validation gate
| Check | Default (`.env`) |
|---|---|
| Test mAP@50 ≥ floor | `GATE_MIN_TEST_MAP50=0.75` |
| Not more than X below the served model, both scored on this run's test set | `GATE_MAX_REGRESSION=0.02` |
| **Overfitting check:** validation mAP@50 (used to pick the checkpoint) − test mAP@50 (never seen) ≤ X | `GATE_MAX_VAL_TEST_GAP=0.05` |

Overfitting is handled at three levels. The checkpoint is chosen by **validation** mAP@50, never by training loss,
so epochs where the model starts to overfit are not kept. **Early stopping** ends training when validation stops
improving. The **gate** rejects a model whose test score falls more than `GATE_MAX_VAL_TEST_GAP` below its
validation score. The training and validation loss at the chosen epoch are shown on the dashboard and logged to
Comet (`overfit_loss_ratio`). They are not a gate, because training loss is measured on augmented images.

A rejected model still gets an S3 version and a Comet experiment, but the alias (production) does not move.

## Comet
Retraining runs log to the Comet project **`signature-ai-detection-retrain`** (`COMET_PROJECT` in `.env`), with tags
`pipeline` and `smoke`/`full` and the run's gate outcome (`gate-deployed` / `gate-rejected`), in workspace
`COMET_WORKSPACE`. The first manual Colab training stays in `signature-ai-detection`.

If experiments do not appear: the notebook's "Comet preflight" cell now fails the run at the start with the reason
(invalid key, or a workspace the key cannot use). Before this check, a bad key let `comet_ml.start()` fall back to an
offline experiment silently, which is why nothing was saved.

## Tested
* `signature_service/tests/test_pipeline_orchestrator.py`: no ZIP, new dataset with a pinned notebook, re-upload of the same
  content, webhook during a run, stale Kaggle status, live-progress merge, gate deploy plus hot reload, Kaggle error with log,
  auto-retry limit, missing config.
* `pipeline/mock/run_mock_orchestrator.py`: the whole system on CPU (real API, Redis, orchestrator, notebook; fake HF, S3 and Kaggle).
  It runs 6 scenarios (no dataset, deploy, duplicate skipped, stop from the dashboard, gate rejection, roll back) and
  takes dashboard screenshots.
* `pipeline/mock/run_mock_pipeline.py`: all notebook cells, including dirty-data cleaning checks.

## Files
* `signature_service/app/retrain.py`: the orchestrator (dataset check, dedup, Kaggle, monitoring, dashboard state).
* `signature_service/app/retrain_tasks.py`: the Celery tasks `pipeline.check` and `pipeline.tick`.
* `signature_service/app/pipeline_api.py`: state and admin endpoints; `web/src/pages/PipelinePage.tsx`: the dashboard
  (`app/static/pipeline_dashboard.html` is the fallback when the React build is missing).
* `signature_service/app/comet_client.py` and `app/alerts.py`: Comet REST reader and alert channels.
* `signature_service/app/webhooks.py`: HF webhook to the pipeline queue.
* `signature_service/docker/pipeline.Dockerfile`: the pipeline container (no torch).
* `pipeline/train_pipeline.ipynb`: generated by `make_pipeline_notebook.py` from `notebooks/01_detection_training_colab.ipynb`.
* `pipeline/kaggle_job.py`: builds the Kaggle job (overrides cell + `kernel-metadata.json`) and creates the secrets dataset.
