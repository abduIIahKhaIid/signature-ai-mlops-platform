# CI/CD: every push to `main` is deployed to EC2 automatically

`.github/workflows/ci-cd.yml` is the **only** GitHub workflow. It tests and deploys the **code**.
It never trains a model: retraining runs on EC2 + Kaggle ([`retraining_pipeline.md`](retraining_pipeline.md)).

```
git push origin main
   │
   ├─ CI ── service-tests     pyflakes + pytest (real Redis, Celery worker, S3 registry via moto)
   │     ── dashboard-tests   node --test (dataset dashboard)
   │     ── pipeline-checks   train_pipeline.ipynb in sync with the training notebook, Kaggle job dry-run, YAML valid
   │     ── docker-build      api + worker + pipeline images build
   │
   └─ CD (all CI green AND something under signature_service/ or pipeline/ changed)
          deploy ── AWS SSM Run Command on the EC2 instance (no SSH key in GitHub, port 22 can stay closed):
                    git fetch + git reset --hard <commit>  →  signature_service/deploy/remote_deploy.sh <commit>
                    → docker compose down (volumes kept) → build api, worker, pipeline one at a time → up -d
                    → wait for /ready → /health must report <commit> → pipeline container running
                 ── verify from outside: $API_URL/health "version" == pushed commit
```

If a deploy secret is missing, the deploy job now **fails (red ❌)** and lists the missing names.
Before this change it only printed a warning and stayed green, so a push could look deployed when it was not.

---

## What you add in GitHub

GitHub → repo → **Settings → Secrets and variables → Actions**

| Tab | Name | Value | Where it comes from |
|---|---|---|---|
| Secrets | `DEPLOY_AWS_ACCESS_KEY_ID` | access key of the IAM user `signatureai-github-deployer` | Step 2 |
| Secrets | `DEPLOY_AWS_SECRET_ACCESS_KEY` | its secret key | Step 2 |
| Secrets | `EC2_INSTANCE_ID` | `i-0…` | EC2 → Instances → Instance ID |
| Secrets | `AWS_REGION` | `ap-southeast-2` | region of the instance (Sydney) |
| Variables | `API_URL` | `http://<elastic-ip>:8000` (no trailing `/`) | optional: enables the outside check |

**Nothing else.** Kaggle, Hugging Face, Comet and S3-write keys are **not** GitHub secrets: they live in the EC2
`.env` and in the private Kaggle secrets dataset. If you added `KAGGLE_USERNAME`, `KAGGLE_KEY`, `KAGGLE_API_TOKEN`,
`HF_TOKEN`, `COMET_API_KEY`, `COMET_WORKSPACE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or `AWS_S3_BUCKET` for
the old `retrain.yml`, delete them from GitHub.

---

## One-time setup, step by step (≈ 20 min)

### Step 1. Let AWS Systems Manager (SSM) reach the instance
1. IAM → **Roles** → `SignatureAI-EC2-Role` (the role attached to the instance) → **Add permissions → Attach policies**
   → tick **`AmazonSSMManagedInstanceCore`** → Add.
2. On the instance (SSH or EC2 Instance Connect):
   ```bash
   sudo snap restart amazon-ssm-agent
   ```
3. AWS Console (region **Sydney**) → **Systems Manager → Fleet Manager**: the instance must show **Online**
   (2–5 min). Not listed = the role or the agent is the problem; deploy cannot work until it is Online.

### Step 2. A deploy-only IAM user for GitHub
1. Open `signature_service/deploy/iam-github-deployer-policy.json` and replace `<INSTANCE_ID>` with your instance ID.
2. IAM → **Policies → Create policy → JSON** → paste it → name `SignatureAI-GitHub-Deploy`.
3. IAM → **Users → Create user** `signatureai-github-deployer` (no console access) → **Attach policies directly**
   → `SignatureAI-GitHub-Deploy`.
4. The user → **Security credentials → Create access key** → use case *Application running outside AWS*
   → copy both values into the GitHub secrets `DEPLOY_AWS_ACCESS_KEY_ID` / `DEPLOY_AWS_SECRET_ACCESS_KEY`.

This user can only run a command on that one instance and read the result. It cannot read S3 or start instances.

### Step 3. The code on EC2 must be a git clone of this repository
The deploy runs `git fetch` + `git reset --hard` in `/home/ubuntu/app`. Check once on the instance:
```bash
cd ~/app && git remote -v && git status
```
* Must show `origin https://github.com/abduIIahKhaIid/signature-ai-mlops-platform`.
* If `~/app` is missing or not a git repository (code copied by hand / scp), re-clone and keep the `.env`:
  ```bash
  cp ~/app/signature_service/.env ~/env.backup 2>/dev/null || true
  mv ~/app ~/app_old_manual
  git clone https://github.com/abduIIahKhaIid/signature-ai-mlops-platform ~/app
  cp ~/env.backup ~/app/signature_service/.env
  ```
* From now on **never edit code on the server**: every deploy resets tracked files to the pushed commit.
  `.env` is not tracked, so it is always kept.

### Step 4. Stable address + open port
1. EC2 → **Elastic IPs → Allocate → Associate** with the instance. Without it the IP changes on every stop/start
   and `API_URL` plus the Hugging Face webhook break.
2. Security group → inbound **TCP 8000 from 0.0.0.0/0** (GitHub runners for the outside check, and Hugging Face).

### Step 5. Add the GitHub secrets and variable
Use the table above. Names are case-sensitive.

### Step 6. Test it
1. Change something small under `signature_service/` (e.g. a log message), then:
   ```bash
   git add -A && git commit -m "test CD" && git push origin main
   ```
2. GitHub → **Actions → CI/CD**: four CI jobs go green, then **Deploy to EC2 (AWS SSM)** runs (≈ 3–15 min;
   the first build without cache is the slowest).
3. The run summary shows `✅ Deployed <sha> to EC2`, and `http://<elastic-ip>:8000/health` returns
   `"version": "<full commit sha>"`.

Deploy is skipped on purpose (summary says so) when only README, docs or notebooks changed.
To deploy anyway: Actions → CI/CD → **Run workflow** → tick *force_deploy*.

---

## Troubleshooting

| Message in the deploy job | Cause and fix |
|---|---|
| `Deploy is not configured. Missing repository secrets: …` | add the named secrets (Step 5) |
| `InvalidInstanceId` | instance not Online in Fleet Manager (Step 1), wrong `EC2_INSTANCE_ID`, or wrong `AWS_REGION` |
| `AccessDeniedException … ssm:SendCommand` | `<INSTANCE_ID>` in the deployer policy not replaced, or wrong account/region in the ARN (Step 2) |
| `fatal: not a git repository` / `/home/ubuntu/app` not found | Step 3 |
| `!! /health does not report <sha>` | an old `api` container is still running: `docker compose ps` on the server |
| `service not ready after 5 minutes` | the job prints the last container logs; often S3 credentials or out of memory |
| outside check `curl` fails | `API_URL` wrong (no trailing `/`), Elastic IP changed, or port 8000 closed |

## Rollback
Actions → CI/CD → **Run workflow** on an older commit (or `git revert <sha>` + push).
Previous image layers are cached on the server, so a rollback deploy takes about a minute.

## Security notes
* No SSH key and no admin AWS key in GitHub; the deploy user can only `ssm:SendCommand` on one instance.
* Server secrets (`.env`: Logfire token, webhook secret, HF/Kaggle keys) stay on the server and are never committed.
* The deploy stops the containers before building (memory-friendly on t3.large), so the API is down for a few minutes
  during a deploy. Redis state, pipeline state and the model cache live in volumes and survive.
* A Kaggle training that is running during a deploy keeps running on Kaggle; the pipeline worker picks it up again
  from Redis when it restarts.
* Upgrade path: GitHub OIDC + an IAM role instead of a long-lived access key.
