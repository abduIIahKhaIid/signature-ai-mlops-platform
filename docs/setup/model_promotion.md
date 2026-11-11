# Model promotion: candidate (`latest`) → served (`production`)

Both models (detector and similarity) have two S3 aliases:

| Alias | Who writes it | Served? |
|---|---|---|
| `aliases/latest.json` | every training notebook run (Colab notebook 01, notebook 02/03, a manual run of the pipeline notebook) | no, it is a **candidate** |
| `aliases/production.json` | only a **validation gate** (retraining pipeline for the detector, notebook 03 for similarity) or an **admin** on the dashboard (Promote, Roll back) | yes, workers follow it |

Every write to `production` carries a **gate record** for exactly that version:

```json
"gate": {"version": "v20261112T…", "passed": true, "checked_by": "pipeline validation gate (Kaggle)", "metrics": {…}}
"gate": {"version": "v20261112T…", "passed": false, "override": true, "approved_by": "dashboard (1.2.3.4)", "reason": "…"}
```

Workers that follow `production` **refuse** an alias without a valid record (`signature_service/app/promotion.py`):
it was not written by a gate or an admin, the record belongs to another version, or the gate rejected the model
without an admin override. They keep serving the current model, and the reason appears in `/v1/model` and on the
dashboard ("Models on the workers"). So a notebook run with the wrong alias name, an alias written by hand, or an
alias copied from another version can never go live by accident.

## What protects what

| Mistake | What stops it |
|---|---|
| Someone sets `S3_ALIAS = 'production'` in notebook 03 | the notebook refuses to start (assert in the configuration cell) |
| A notebook or a person writes `production.json` without a gate record | workers refuse it and keep the current model |
| The record is copied from another version | workers refuse it (`gate.version` must equal the alias `version`) |
| A worse model is trained | the gate rejects it: floor + no regression against the served model **on the same test set** |
| The worker restarts while `production` points to an unapproved release | it serves the last approved detector of this host (model cache) and shows the error; the similarity model is skipped and detection keeps working |
| A release that fails to download / verify / load | the old model keeps serving; that release is not downloaded again for `FAILED_RELEASE_RETRY_SECONDS` |

Limits: the record guards against mistakes, not against someone who deliberately writes a fake record with S3 write
access. The Kaggle key needs to write `production` (the gates run on Kaggle), so IAM cannot forbid it there. The next
step for that is to let only EC2 write `production` (the gate result is already stored in S3 for EC2 to read).

## The gates

* **Detector** (`pipeline/train_pipeline.ipynb`, started by the EC2 orchestrator): test mAP@50 ≥ `GATE_MIN_TEST_MAP50`,
  at most `GATE_MAX_REGRESSION` below the served model on this run's test set, validation–test gap ≤
  `GATE_MAX_VAL_TEST_GAP`. Training warm-starts from, and is compared with, the model behind `MODEL_ALIAS`.
* **Similarity** (`notebooks/03_similarity_same_dataset_kaggle.ipynb`): test AUC ≥ `GATE_MIN_TEST_AUC` (0.90),
  test EER ≤ `GATE_MAX_TEST_EER` (0.15), and against the served model on this run's test pairs: EER at most
  `GATE_MAX_EER_REGRESSION` (0.02) worse, AUC at most `GATE_MAX_AUC_DROP` (0.01) lower. The verdict is saved as
  `versions/<version>/gate.json`; with `AUTO_PROMOTE = False` it only writes the candidate.

## Dashboard: Promote

`/pipeline` → **Models on the workers** shows, per model, what the workers serve, the production release with its gate
badge (gate passed / admin override / no gate record), and a newer candidate if there is one. **Promote candidate**
(admin token) moves `production` to it:

* candidate passed its gate → promoted with that verdict;
* otherwise a **reason is required** and the record says *admin override*.

Same through the API, also for any older version:

```bash
curl -X POST https://<host>/v1/pipeline/promote -H "X-Admin-Token: $PIPELINE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "detection", "version": "v20261109T142002Z-8a4d7444", "reason": "best full-data model (test mAP@50 0.807)"}'
```

**Roll back** (detector) writes an admin record too, so the rolled-back alias is accepted.

## Switching an existing server to `production` (once)

The server currently follows `latest`. Do these steps in this order, otherwise the workers start with an alias they
must refuse:

1. **Merge** the code and let CI/CD deploy it (workers still follow `latest`, nothing changes yet).
2. **IAM**: update the EC2 role with `signature_service/deploy/iam-ec2-role-policy.json` (adds `PutObject` on
   `signatureai/similarity/aliases/*`, needed by Promote for the similarity model).
3. **Create the production aliases** on `/pipeline` → *Models on the workers*: the candidate is what is served today,
   so **Promote candidate** for the detector and for similarity, reason e.g. `bootstrap: model served before gating`.
   For the detector you may want the full-data model instead of the latest smoke run, with the `curl` above.
4. **Secrets Manager** → `signatureai/prod/dotenv`: `MODEL_ALIAS=production` and `SIMILARITY_S3_ALIAS=production`.
5. **Redeploy** (GitHub → Actions → CI/CD → Run workflow → *force_deploy*) so the new `.env` is used.
6. **Check** `/pipeline` → *Models on the workers*: no yellow "Workers follow 'latest'" warning, both production
   releases show a gate badge, no hot-reload error.

From then on: retraining runs promote by themselves when the gate passes, notebook runs only create candidates, and
an admin decides about everything else with a recorded reason.
