# SignatureAI — signature detection, similarity and MLOps

End-to-end system that finds signatures in document images (RT-DETRv2, Apache-2.0, **no Ultralytics**),
scores signature similarity, serves both through **FastAPI + Redis + Celery**, and retrains automatically
when the Hugging Face dataset changes. Experiments are tracked in **Comet**, models are versioned in **Amazon S3**.

## Repository layout

| Folder / file | What it is |
|---|---|
| `dataset_dashboard/` + `START_DASHBOARD.bat` | Local dataset review tool (Node.js): import ZIP / HF dataset, fix boxes, export, publish a clean ZIP to Hugging Face |
| `notebooks/01_detection_training_colab.ipynb` | Detection training run with outputs: HF download → cleaning + leakage gate → RT-DETRv2 training → Comet → S3 version |
| `notebooks/02_similarity_siamese.ipynb` | Similarity: SSIM vs ImageNet ResNet18 vs Siamese ResNet18 on CEDAR (writer-disjoint), threshold, S3 export (`.py` = editable source) |
| `notebooks/archive/` | Earlier notebook version, kept for history |
| `signature_service/` | Inference service: FastAPI API, Celery workers, Redis, Docker Compose, EC2 deploy, Locust load test, tests |
| `pipeline/` | Automated retraining: Kaggle notebook (`train_pipeline.ipynb`), job script, setup guide |
| `.github/workflows/retrain.yml` | GitHub Actions orchestrator for retraining (HF webhook / schedule / manual) |
| `.github/workflows/ci-cd.yml` | CI (tests, checks, Docker builds) + CD to EC2 via AWS SSM: [`signature_service/deploy/CI_CD.md`](signature_service/deploy/CI_CD.md) |
| `docs/` | Measured results per phase (EC2 queue tests, similarity evaluation, …) |

**Not in git (by design):** datasets (`Dataset/`, on Hugging Face), model weights (S3), `.env` files and keys,
dashboard working data (`.signature-dashboard/`), `node_modules/`.

## Architecture

```
Hugging Face dataset ──webhook──▶ API /webhooks/huggingface ──▶ GitHub Actions ──▶ Kaggle GPU training
        ▲                                                                              │ Comet metrics
 dataset dashboard                                                                     ▼
                                                     S3: versions/<v>/artifact.zip + manifest (SHA-256)
                                                         aliases/latest.json  ◀── validation gate
                                                                │ hot reload
client ──HTTP──▶ FastAPI (EC2) ──job──▶ Redis ──▶ Celery workers (RT-DETRv2 + Siamese ResNet18) ──▶ result
                    └── Logfire traces: request → queue wait → inference
```

## Where to start
* Run the service locally or on EC2: [`signature_service/README.md`](signature_service/README.md),
  [`signature_service/deploy/DEPLOY_EC2.md`](signature_service/deploy/DEPLOY_EC2.md)
* Retraining pipeline: [`pipeline/README_PIPELINE.md`](pipeline/README_PIPELINE.md)
* Dataset dashboard: [`dataset_dashboard/README.md`](dataset_dashboard/README.md)

## Key results (detection, run `v20261109T142002Z-8a4d7444`)
28,958 images (22,953 / 3,287 / 2,718 train / val / test), leakage gate passed.
Held-out test: mAP@50 **0.807**, mAP@[.5:.95] 0.554 (best epoch 1, early stopping at epoch 3).
