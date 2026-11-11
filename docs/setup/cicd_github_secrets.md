# CI/CD: every push to `main` is deployed to EC2 automatically

`.github/workflows/ci-cd.yml` is the **only** GitHub workflow. It tests and deploys the **code**.
It never trains a model: retraining runs on EC2 + Kaggle ([`retraining_pipeline.md`](retraining_pipeline.md)).

```
git push origin main
   │
   ├─ CI ── service-tests     pyflakes + pytest (real Redis, Celery worker, S3 registry via moto, deploy rollback)
   │     ── dashboard-tests   node --test (dataset dashboard)
   │     ── web-app           React type check + build
   │     ── pipeline-checks   notebook in sync, Kaggle job dry-run, YAML valid, deploy scripts (bash -n, shellcheck)
   │     ── mock-pipeline     the real Kaggle notebook (all cells) + the real orchestrator scenario on CPU,
   │                          with HF / S3 / Comet / Kaggle / GPU faked (~6 min)
   │     ── docker-build      api + worker + pipeline images; on main they are PUSHED to ECR as
   │                          <registry>/signatureai:{api,worker,pipeline}-<commit>   (needs ECR_REPOSITORY, step 7)
   │
   └─ CD (all CI green AND something under signature_service/ or pipeline/ changed)
          deploy ── AWS SSM Run Command on the EC2 instance (no SSH key in GitHub, port 22 can stay closed):
                    git fetch + git reset --hard <commit>  →  signature_service/deploy/remote_deploy.sh <commit> [<ecr-image>]
                    → .env from Secrets Manager (validated; on error nothing is touched)
                    → ECR: docker compose pull while the old version keeps serving → up -d (seconds of downtime)
                      no ECR: docker compose down → build one image at a time → up -d (minutes of downtime)
                    → wait for /ready → /health must report <commit> → pipeline container running
                    → FAILED? automatic rollback to the last good commit (.deployed_sha), job still red
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
| Variables | `ECR_REPOSITORY` | `signatureai` | optional but recommended: build once in CI, EC2 only pulls (Step 7) |

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

### Step 6. Test it (Step 7 can be done before or after)
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

### Step 7. Build once in CI, EC2 only pulls (Amazon ECR)
Without this step EC2 builds the three images itself on every deploy: the API is down for minutes and the image that
runs is not byte-for-byte the one CI tested. With it, CI pushes the tested images and EC2 only pulls and swaps them.
1. Create the repository once (AWS CloudShell, region Sydney):
   ```bash
   aws ecr create-repository --repository-name signatureai --region ap-southeast-2 \
     --image-scanning-configuration scanOnPush=true
   # keep the last 30 images only (each deploy pushes 3), so storage stays cheap
   aws ecr put-lifecycle-policy --repository-name signatureai --region ap-southeast-2 --lifecycle-policy-text \
     '{"rules":[{"rulePriority":1,"description":"keep 30","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":30},"action":{"type":"expire"}}]}'
   ```
2. IAM → Policies → `SignatureAI-GitHub-Deploy` → **Edit** → paste the new
   `signature_service/deploy/iam-github-deployer-policy.json` (adds ECR push on that one repository).
3. IAM → Roles → `SignatureAI-EC2-Role` → update its inline policy with `signature_service/deploy/iam-ec2-role-policy.json`
   (adds ECR pull and `secretsmanager:GetSecretValue` on `signatureai/prod/dotenv`, which `sync_secrets.sh` needs).
4. GitHub → Settings → Secrets and variables → Actions → **Variables** → `ECR_REPOSITORY` = `signatureai`.
5. The instance needs the AWS CLI (`aws --version`). New instances get it from `ec2_user_data.sh`; on an older one:
   `sudo snap install aws-cli --classic`.

Next push: the `docker-build` job summary shows `📦 Pushed …`, and the deploy log shows
`pulling …:{api,worker,pipeline}-<sha> (old version keeps serving meanwhile)`.

---

## Troubleshooting

| Message in the deploy job | Cause and fix |
|---|---|
| `Deploy is not configured. Missing repository secrets: …` | add the named secrets (Step 5) |
| `InvalidInstanceId` | instance not Online in Fleet Manager (Step 1), wrong `EC2_INSTANCE_ID`, or wrong `AWS_REGION` |
| `AccessDeniedException … ssm:SendCommand` | `<INSTANCE_ID>` in the deployer policy not replaced, or wrong account/region in the ARN (Step 2) |
| `fatal: not a git repository` / `/home/ubuntu/app` not found | Step 3 |
| `!! /health does not report <sha>` | an old `api` container is still running: `docker compose ps` on the server |
| `service not ready after 300 seconds` | the job prints the last container logs; often S3 credentials or out of memory. The deploy then rolls back by itself |
| `the new version failed its checks on EC2 and was ROLLED BACK` | the previous commit is serving again; fix the bug and push. `cat ~/app/signature_service/.deployed_sha` on the server shows the commit that is live |
| `rollback … also failed: the service is DOWN` / exit code 2 | read the logs in the job; then deploy a known good commit with **Run workflow** (force_deploy) |
| `could not pull the images from ECR: nothing was changed` | Step 7: EC2 role lacks ECR pull, the AWS CLI is missing on the instance, or the images were not pushed |
| `no basic auth credentials` / `denied` in docker-build | Step 7.2: deployer policy lacks ECR push, or `ECR_REPOSITORY` names another repository |
| `mock-pipeline` red | the retraining notebook or orchestrator is broken; the job uploads `mock-pipeline-logs` with each run's log |
| outside check `curl` fails | `API_URL` wrong (no trailing `/`), Elastic IP changed, or port 8000 closed |

## Rollback
**Automatic:** `remote_deploy.sh` remembers the last commit that passed every check (`signature_service/.deployed_sha`
on the server, never in git). If a new version is not ready within 5 minutes, reports the wrong commit, or the pipeline
container is down, it resets the code to that commit and starts its images again: from the instance (kept), else
from ECR, else by building. The job stays red so you notice, but the service is back on the old version.

**By hand:** Actions → CI/CD → **Run workflow** on an older commit (or `git revert <sha>` + push).
With ECR the images of that commit are pulled, so this takes about a minute.

## Security notes
* No SSH key and no admin AWS key in GitHub; the deploy user can only `ssm:SendCommand` on one instance.
* Server secrets (`.env`: Logfire token, webhook secret, HF/Kaggle keys) stay on the server and are never committed.
* With ECR (Step 7) the new images are pulled while the old containers keep serving; only the container swap is
  downtime (seconds). Without ECR the deploy stops the containers before building (memory-friendly on t3.large),
  so the API is down for a few minutes. Redis state, pipeline state and the model cache live in volumes and survive.
* A Kaggle training that is running during a deploy keeps running on Kaggle; the pipeline worker picks it up again
  from Redis when it restarts.
* Upgrade path: GitHub OIDC + an IAM role instead of a long-lived access key.
