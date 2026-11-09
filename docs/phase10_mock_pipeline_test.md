# Phase 10: retraining pipeline mock test (2026-11-10)

`pipeline/train_pipeline.ipynb` was executed end to end. All 24 code cells ran in order, using the same code Kaggle runs. Only the outside services were replaced:

| Real service | Mock used |
|---|---|
| Hugging Face dataset repo | Synthetic YOLO ZIP (76 images) plus a fake `HfApi` / `hf_hub_download` |
| Amazon S3 | moto, pre-loaded with a served model behind `aliases/latest.json` |
| Comet | A recorder that keeps every parameter, metric and asset |
| T4 GPU | CPU, with a tiny RT-DETRv2 |

Script: `pipeline/mock/run_mock_pipeline.py <repo_root>`. It runs on CPU in about 1.5 minutes.

## Results

| Stage | What was checked | Result |
|---|---|---|
| Dataset pick | Newest ZIP chosen out of 2 ZIPs and a README, pinned to the HF commit | ✅ |
| Cleaning: corrupt image | `invalid_images.csv` | ✅ caught |
| Cleaning: bad boxes | Box outside the image and zero-width box, logged in `bad_bounding_boxes.csv` | ✅ caught, image quarantined |
| Cleaning: exact duplicate | `exact_duplicates_removed.csv` | ✅ removed |
| Leakage: test image copied into train | `exact_cross_split_leakage.csv` | ✅ train copy removed, test copy kept |
| Near-duplicate screen and leakage gate | pHash + SSIM | ✅ PASS |
| Split | 76 source images became train 48 / val 12 / test 12 | ✅ |
| Warm start | `Initial weights: latest -> v-served-champion` | ✅ fine-tunes the served model |
| Training | Losses, val mAP, early stopping, `training_history.csv`, S3 checkpoint | ✅ |
| Evaluation | Test is scored once after training; curves and prediction sample saved | ✅ |
| Threshold calibration | Best-F1 threshold on validation, never on test | ✅ |
| Versioning | Immutable `versions/<v>/artifact.zip` plus `manifest.json` (SHA-256) | ✅ |
| Gate (deploy case) | Alias moves to the new version and records `previous_version` | ✅ |
| Gate (real rules, floor 0.75) | Weak model is **rejected**, and `latest` stays on the champion | ✅ |
| Comet | 27 params, 37 metric names, 7 assets, curves image, S3 model URI, tags | ✅ |
| Run records | `pipeline_runs/<v>.json`, `hf_commits/<sha>.json`, `pipeline_result.json` | ✅ |

mAP is 0 in the mock. That is expected: the mock uses a random tiny model, 1 CPU epoch and 72 synthetic images. The test checks the plumbing, not accuracy.

## Bug found and fixed

The last cell, the hand-off to GitHub Actions, crashed with `SameFileError` when run outside Kaggle (Colab or local). It now writes to `run/handoff/`. Kaggle runs were not affected.

## Train new or fine-tune?

The pipeline **fine-tunes** the model that is currently served (`INIT_FROM='latest'`, a warm start). It does not train from zero. Set `INIT_FROM='base'` to restart from the Apache-2.0 COCO-pretrained `PekingU/rtdetr_v2_r18vd`.
