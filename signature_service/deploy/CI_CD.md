# CI/CD for the SignatureAI code

`.github/workflows/ci-cd.yml`

```
git push / pull request
   │
   ├─ CI ── service-tests     pyflakes + 29 pytest tests (real Redis, Celery worker, S3 registry via moto)
   │     ── dashboard-tests   node --test (dataset dashboard)
   │     ── pipeline-checks   train_pipeline.ipynb in sync with the training notebook, no undefined names,
   │                          Kaggle job dry-run build, workflow YAML valid
   │     ── docker-build      api + worker images build (layer cache in GitHub)
   │
   └─ CD (push to main, all CI green, something under signature_service/ changed)
          deploy ── AWS SSM Run Command on the EC2 instance (no SSH key in GitHub, port 22 stays closed):
                    git reset --hard <commit> → deploy/remote_deploy.sh <commit>
                    → docker compose up -d --build → wait for /ready → /health must report <commit>
                 ── verify from outside: $API_URL/health version == pushed commit
```

The **retraining** pipeline (`retrain.yml`, Phase 10) is separate: it changes the *model*; this one changes the *code*.

## One-time setup (≈ 15 min)

### 1. Let SSM manage the instance
IAM → Roles → `SignatureAI-EC2-Role` → **Add permissions → Attach policies** → `AmazonSSMManagedInstanceCore`.
Then on the instance: `sudo snap restart amazon-ssm-agent`.
Check: AWS Console → **Systems Manager → Fleet Manager** (region Sydney): the instance is listed as *Online*
(can take 2–5 min).

### 2. A deploy-only IAM user for GitHub
IAM → Users → Create user `signatureai-github-deployer` (no console access) → Attach policy created from
`signature_service/deploy/iam-github-deployer-policy.json` (replace `<INSTANCE_ID>` first) →
Security credentials → **Create access key** (use case: "Application running outside AWS").
This user can only run commands on this one instance and read their result.

### 3. GitHub repository settings
Settings → Secrets and variables → Actions

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_AWS_ACCESS_KEY_ID` | key of `signatureai-github-deployer` |
| Secret | `DEPLOY_AWS_SECRET_ACCESS_KEY` | its secret |
| Secret | `EC2_INSTANCE_ID` | e.g. `i-0fe82ffbcabf138e0` (EC2 → Instances) |
| Secret | `AWS_REGION` | `ap-southeast-2` (already added for Phase 10) |
| Variable | `API_URL` | `http://13.239.137.202:8000` (needs port 8000 open to 0.0.0.0/0; leave unset to skip the external check) |

Until these exist, CI still runs and the deploy job only prints a warning.

## Demo
1. Change something small in `signature_service/` (e.g. a log message), commit, push.
2. GitHub → Actions → **CI/CD**: four CI jobs go green, then **Deploy to EC2** runs.
3. Summary shows "Deployed `<sha>` to EC2"; `http://<EC2>:8000/health` → `"version": "<full sha>"`.
4. Break a test on purpose → CI fails → deploy job is skipped, production keeps the last good version.

## Rollback
GitHub → Actions → CI/CD → **Run workflow** on an older commit (or `git revert` + push).
On the server the previous images are still cached, so a rollback deploy takes about a minute.

## Security notes
* No SSH key or AWS admin key in GitHub; the deploy user is limited to `ssm:SendCommand` on one instance.
* `.env` (Logfire token, webhook secret…) stays on the server: `git reset --hard` never touches untracked files.
* Upgrade path: replace the deploy user's access key with GitHub OIDC + an IAM role (no long-lived key).
