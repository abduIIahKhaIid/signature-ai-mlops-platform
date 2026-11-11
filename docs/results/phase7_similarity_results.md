# Phase 7 — Signature similarity results

**Notebook:** `notebooks/archive/02_similarity_siamese_cedar_kaggle.ipynb` (Kaggle GPU)
**Data:** CEDAR (`1aurent/individuality-of-handwriting`), 55 writers × 24 genuine + 24 skilled forgeries.
**Protocol:** writer-disjoint split (train / validation / test writers never overlap). The decision threshold is the
validation EER point and is applied once to the unseen test writers.
Pairs: genuine–genuine (same writer), genuine–skilled forgery (same name, forger), genuine–random (other writer).

## Held-out test writers

| Method | Val EER | Threshold (from val) | Test AUC | **Test EER** | Test FAR | Test FRR | Test accuracy | Skilled EER | Skilled FAR | Random EER | Random FAR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SSIM (pixels) | 0.508 | 0.749 | 0.544 | 0.455 | 0.600 | 0.350 | 0.483 | 0.553 | 0.772 | 0.383 | 0.428 |
| ResNet18 ImageNet (previous API baseline) | 0.070 | 0.902 | 0.932 | 0.145 | 0.190 | 0.122 | 0.833 | 0.147 | 0.230 | 0.142 | 0.150 |
| **Siamese ResNet18 (deployed)** | **0.018** | **0.714** | **0.990** | **0.050** | **0.073** | **0.023** | **0.944** | **0.008** | **0.000** | **0.074** | **0.145** |

FAR = forgeries accepted, FRR = genuine signatures rejected (lower is better for both).

## Interpretation
* **SSIM is near chance** (AUC 0.54): pixel overlap cannot cope with natural variation in how a person signs.
* **ImageNet features already help** (AUC 0.93) but confuse writers (EER 14.5 %).
* **Siamese fine-tuning cuts the error ~3×** (EER 14.5 % → 5.0 %, AUC 0.99). At the validation threshold 0.714 it
  accepted **no skilled forgery** in the test writers and rejected only 2.3 % of genuine signatures.
* The remaining weakness is **random forgeries** (another person's genuine signature): FAR 14.5 % at the shared
  threshold. Skilled forgeries were the hard negatives during training, so the model learned them best; adding more
  other-writer negatives or a per-use-case threshold would trade FRR for lower random FAR.

## Limitations
* Only 10 test writers: a few % variance between runs/splits is expected.
* CEDAR signatures are clean scans; signatures cropped by the detector from real documents (stamps, lines, low
  resolution) are a different domain, so expect lower accuracy in production until trained on in-domain pairs.
* Verification decision = cosine similarity ≥ 0.714 (stored in S3 `signatureai/similarity/aliases/latest.json`,
  loaded by the API with `SIMILARITY_S3_ALIAS=latest`).
