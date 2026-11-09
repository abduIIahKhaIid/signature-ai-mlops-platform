# Phase 10 — Automated retraining & deployment pipeline

```
 Dataset dashboard ──publish ZIP──▶ Hugging Face dataset (new commit)
                                        │  webhook (X-Webhook-Secret)          ┌─ fallback: GitHub cron every 30 min
                                        ▼                                       │  checks HF main vs trained commits
                     EC2 API  POST /webhooks/huggingface                         │
                     verify secret · filter · de-dup in Redis                    │
                                        │  repository_dispatch                   │
                                        ▼                                       ▼
                     GitHub Actions  .github/workflows/retrain.yml  ◀────────────┘   (+ manual "Run workflow")
                     secrets → private Kaggle dataset · build notebook · kaggle kernels push · wait
                                        │
                                        ▼
                     Kaggle GPU  pipeline/train_pipeline.ipynb
                     HF commit pinned → cleaning + leakage gate → warm-start RT-DETRv2 → Comet metrics
                     → test eval → threshold calibration → S3 versions/<v>/ (immutable, SHA-256)
                     → VALIDATION GATE (floor + no regression vs served model)
                     → pass: move S3 aliases/latest.json   fail: keep old model, report "rejected"
                                        │
                                        ▼
                     EC2 Celery workers poll the alias (MODEL_POLL_SECONDS) → download, verify,
                     load new model, then swap (zero downtime). Old model keeps serving on any error.
```

## One-time setup (≈ 25 min)

### 1. Kaggle
1. kaggle.com → Settings → **Phone verification** (needed for GPU + internet).
2. Settings → API → **Create New Token** → `kaggle.json` (`username`, `key`).

### 2. GitHub repository secrets / variables
Repo → Settings → Secrets and variables → Actions.

| Secret | Value |
|---|---|
| `KAGGLE_USERNAME` | your Kaggle username |
| `KAGGLE_KEY` **or** `KAGGLE_API_TOKEN` | legacy key from `kaggle.json`, or a new Kaggle API token (Settings → API) |
| `COMET_API_KEY` (+ optional `COMET_WORKSPACE`) | Comet |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the `signatureai-colab-uploader` user (read/write on `signatureai/detection/*`) |
| `AWS_REGION` | `ap-southeast-2` |
| `AWS_S3_BUCKET` | `signatureai-df-detr-models` |
| `HF_TOKEN` | **required**: the dataset repo is private. HF → Settings → Access Tokens → *Read* token |

| Variable (Variables tab) | Value |
|---|---|
| `HF_DATASET_REPO` | `mabdullahkhalid/Signature_Dataset_Detection` |

Secrets reach Kaggle through a **private** Kaggle dataset `<user>/signatureai-pipeline-secrets` that the
workflow refreshes on every run; nothing secret is written into the notebook.

### 3. Webhook receiver on EC2 (`signature_service/.env`)
```
HF_WEBHOOK_SECRET=<long random string>
HF_DATASET_REPO=mabdullahkhalid/Signature_Dataset_Detection
GITHUB_REPO=<github-user>/<repo>
GITHUB_TOKEN=<fine-grained token, this repo only, permission "Contents: Read and write">
RETRAIN_MODE=smoke
```
`docker compose up -d api` to apply.

### 4. Hugging Face webhook
huggingface.co → Settings → **Webhooks** → Add:
* Target repositories: the dataset `mabdullahkhalid/Signature_Dataset_Detection`
* URL: `http://<EC2-public-IP>:8000/webhooks/huggingface`
* Secret: same value as `HF_WEBHOOK_SECRET`
* Triggers: **Repo update**

If HF refuses a plain-http URL, skip this step: the **30-minute GitHub schedule** detects the new commit anyway.

## Demo script
1. **Manual run first** (fast proof): GitHub → Actions → *Retrain signature detector* → Run workflow → `smoke`.
   Watch: Actions log → Kaggle notebook running → Comet experiment (tags `pipeline`, `smoke`) →
   S3 `versions/<new>/` and `pipeline_runs/<new>.json` → Actions **Summary** table.
2. When the summary says `deployed`, call `GET http://<EC2>:8000/v1/model` within `MODEL_POLL_SECONDS`
   (default 300 s): `detector_version` changes to the new version without restarting anything.
3. **Real trigger**: publish a cleaned dataset from the dashboard to the HF repo → the API log shows
   `retraining dispatched` (or the next scheduled check picks it up) → same flow.

## Which data is trained
Every upload is a **complete reviewed dataset ZIP** (as exported by the dataset dashboard), with any file name.
The pipeline pins the HF commit and trains on the **most recently committed `.zip`** in the repo
(`HF_ZIP_FILENAME='auto'`); the chosen file is printed, logged to Comet and stored in the run report.

## Validation gate
| Check | Default | Where |
|---|---|---|
| Test mAP@50 ≥ floor | 0.75 | `--gate-floor` in `kaggle_job.py build` |
| Not worse than the **currently served model, scored on this run's test set** (champion vs challenger) by more than | 0.02 | `--gate-max-regression` |
| Outcome | `deployed` / `approved_not_deployed` / `rejected` | Actions summary, `pipeline_runs/<v>.json`, Comet tag `gate-*` |

A rejected model still gets an immutable S3 version and Comet experiment (for analysis), but the
alias, and therefore production traffic, does not move.

## Modes
| Mode | What | Time on Kaggle T4/P100 |
|---|---|---|
| `smoke` | warm start from served model, 2,000 train / 500 val images, 1 epoch, full test set | ≈ 35–50 min (data download + cleaning included) |
| `full` (default for webhook + schedule) | warm start, whole dataset, up to 8 epochs with early stopping | several hours. GitHub waits up to 5 h; if training is longer, Kaggle keeps going and the result still lands in S3 `pipeline_runs/` and Comet, and the gate still deploys |

## Files
* `pipeline/train_pipeline.ipynb` — generated by `make_pipeline_notebook.py` from the Colab notebook; runs on Colab or Kaggle.
* `pipeline/kaggle_job.py` — `secrets`, `build`, `wait`, `summary`, `check-hf` steps used by the workflow.
* `.github/workflows/retrain.yml` — the orchestrator.
* `signature_service/app/webhooks.py` — HF webhook → GitHub dispatch (secret check, filters, per-commit de-dup, 30-min cooldown).

## GPU
The workflow pushes the kernel with `--accelerator NvidiaTeslaT4`: Kaggle's current PyTorch build no longer supports
the P100 (sm_60). The notebook also stops within seconds if it lands on an unsupported GPU.

## Not verified yet (verify during the first run)
The notebook's static checks pass, but it has not run end-to-end on Kaggle: the first `smoke` run is the real test.
Most likely first-run issues: Kaggle GPU/internet not enabled (phone verification), the secrets dataset not yet
"ready", or the Kaggle CLI auth variables.
