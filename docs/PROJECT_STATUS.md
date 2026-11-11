# Project status — SignatureAI (checked 2026-11-12)

The phase list below is reconstructed from the repository (the `phaseN_*.md` results, notebooks, services and
commits). Compare it once with the supervisor's original requirement list and add any item that is missing here.

Legend: ✅ done with evidence in the repo · ⚠️ done, but evidence or a final step is missing · ❌ not done

## Requirement checklist

| # | Requirement | Status | Evidence | What is still open |
|---|---|---|---|---|
| 1 | Collect and merge signature datasets | ✅ | `Dataset/merged_signature_dataset` (local), HF repo `mabdullahkhalid/Signature_Dataset_Detection`; 28,958 images after cleaning | — |
| 2 | Clean / review annotations, export, publish | ✅ | `dataset_dashboard/` (Node.js, 14 test files), publish ZIP to Hugging Face | — |
| 3 | Signature **detection** model, no Ultralytics | ✅ | `notebooks/01_detection_training_colab.ipynb`: RT-DETRv2 (Apache-2.0), leakage gate, test mAP@50 **0.807**, mAP@[.5:.95] 0.554 | — (D-FINE Large experiment `notebooks/04_…` stays local, not part of the submission) |
| 4 | Experiment tracking + model versioning | ✅ | Comet projects `signature-ai-detection(-retrain)`; S3 `versions/<v>` (immutable) + `aliases/` | — |
| 5 | Deploy as an API on AWS EC2 | ✅ | `signature_service/` (FastAPI, Docker), [`results/phase5_6_ec2_queue_results.md`](results/phase5_6_ec2_queue_results.md), live `http://13.236.244.226:8000` | HTTPS only through optional Caddy/sslip.io |
| 6 | Message queue for inference | ✅ | Redis + Celery, retries with backoff, 20/20 parallel jobs succeeded (phase 6 table) | — |
| 7 | Signature **similarity / verification** | ✅ | Siamese ResNet18, test EER **5.0 %**, AUC 0.99 on CEDAR, writer-disjoint ([`results/phase7_similarity_results.md`](results/phase7_similarity_results.md)); `/v1/verify`, pairwise compare in `/v1/detect` | `notebooks/03_similarity_same_dataset_kaggle.ipynb` (current similarity trainer with its own gate) has no results file: add its test AUC/EER |
| 8 | Monitoring / observability | ⚠️ | Logfire traces API → Redis → worker, CPU/RAM metrics, SQL queries ([`results/phase8_observability.md`](results/phase8_observability.md)) | the **6 Logfire screenshots** the doc links to are not in `docs/images/` |
| 9 | Stress test + cold start | ⚠️ | `signature_service/loadtest/` (Locust steps 1→40 users, report generator), `scripts/measure_cold_start.py` | **`docs/results/phase9_stress_test.md` was never generated** (no run data in the repo) |
| 10 | CI/CD + continuous training (MLOps) | ✅ | `.github/workflows/ci-cd.yml` (tests, ECR, SSM deploy, automatic rollback); HF webhook → EC2 orchestrator → Kaggle T4 → validation gate → S3 → hot reload; mock tests ([`results/phase10_mock_pipeline_test.md`](results/phase10_mock_pipeline_test.md)); screenshots in `images/` | promotion gate is merged (PR #5), but the server still follows `latest`: `production` aliases not created yet |
| — | Documentation + architecture diagrams | ✅ | `README.md`, `docs/setup/*`, `docs/architecture/` (flow diagrams + AWS-icon diagrams) | — |
| — | Reproducible on another AWS account | ✅ | [`setup/aws_new_account_setup.md`](setup/aws_new_account_setup.md) + `infra/aws/` (policy templates, `setup_aws.sh`) | — |

## To finish the project (in this order)

1. **Commit this cleanup** on a new branch, push, open a pull request into `main` and merge it (CI/CD deploys it).
2. **Production aliases** (promotion gate is already merged, PR #5): double-click
   `signature_service/scripts/PROMOTE_SERVED_MODELS.bat`. It promotes exactly the detector and similarity versions the
   workers serve now (detector `v20261111T160801Z-be43693e`, similarity `v20261111T182624Z-c06766ad` on 2026-11-12),
   with an admin reason. Then Secrets Manager `signatureai/prod/dotenv`: `MODEL_ALIAS=production`,
   `SIMILARITY_S3_ALIAS=production`, and redeploy ([`setup/model_promotion.md`](setup/model_promotion.md)).
3. **Phase 9:** double-click `signature_service/loadtest/RUN_PHASE9_STRESS_TEST.bat` (Locust 1→40 users, ~10 min),
   then `python loadtest/report.py --run loadtest/results/ec2_t3large`. Cold start (optional, on EC2):
   `python3 scripts/measure_cold_start.py --fresh` and without `--fresh`.
4. **Phase 8:** double-click `signature_service/scripts/RUN_PHASE8_DEMO.bat`, then take the 6 Logfire screenshots
   listed in [`images/README.md`](images/README.md).
5. **Similarity:** write the test AUC / EER of notebook 03 (served version `v20261111T182624Z-c06766ad`, threshold 0.984)
   into `docs/results/phase7_similarity_results.md` (new section "same-dataset model").
6. **Detector numbers:** the served detector `v20261111T160801Z-be43693e` is newer than the 0.807 run in the README.
   Copy its test mAP@50 from Comet / its S3 manifest into the README "Key results".
7. Before the demo: rotate any key that was ever pasted in a chat or a screenshot, stop the instance afterwards
   (keep the Elastic IP attached, a detached one is billed).

## Repository health (checked)
* Secrets: `signature_service/.env` is git-ignored and **not** tracked; `keys/` is empty; no access key in tracked files.
  Notebook 01's saved output shows the AWS account ID in an old error message (not a secret).
* Large files: datasets, ZIPs and weights are git-ignored; the largest tracked file is notebook 01 (1.5 MB, outputs kept as evidence).
* Local only, not in git: `.signature-dashboard/` (dashboard working data; the two `ui-backup-*` folders inside are
  old copies of the dashboard UI from 2026-11-09 and can be deleted).
