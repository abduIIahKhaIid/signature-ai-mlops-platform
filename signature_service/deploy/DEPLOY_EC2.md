# Deploy on AWS EC2 (≈ 30 minutes)

Region: **ap-southeast-2 (Sydney)**, same as the model bucket (fast model download, no cross-region cost).

## 0. Put the code on GitHub (once)
Push the project **without** datasets, zips, `.env` or model files (all already in `.gitignore`).
EC2 clones it from there, and the retraining pipeline (Phase 10) runs from the same repo.
Private repo? Use `https://<github-user>:<fine-grained-read-token>@github.com/<user>/<repo>.git` as `REPO_URL`,
or make the repo public for the demo.

## 1. IAM role for the instance (no keys on the server)
IAM → Roles → Create role → **AWS service: EC2** → next → Create policy → JSON → paste
`deploy/iam-ec2-role-policy.json` → name `SignatureAI-EC2-ReadModels` → attach → role name `SignatureAI-EC2-Role`.

## 2. Launch the instance
EC2 → Launch instance:
* Name `signatureai-api`, AMI **Ubuntu Server 24.04 LTS (x86_64)**
* Type **t3.large** (2 vCPU, 8 GB). For bigger stress-test numbers: c6i.xlarge (4 vCPU).
* Key pair: create/download one (for SSH)
* Network → Security group: allow **SSH 22 from My IP** and **Custom TCP 8000 from Anywhere** (demo)
* Storage: **30 GB** gp3
* Advanced details:
  * IAM instance profile: **SignatureAI-EC2-Role**
  * **Metadata response hop limit: 2**  ← required, otherwise boto3 *inside Docker* cannot get the role credentials
  * User data: paste `deploy/ec2_user_data.sh` (after editing `REPO_URL`)

## 3. Watch it come up (≈ 10–15 min first time)
```bash
ssh -i key.pem ubuntu@<public-ip>
sudo tail -f /var/log/cloud-init-output.log        # until "SIGNATURE SERVICE STARTED"
cd ~/app/signature_service && docker compose logs -f worker   # until "models ready in ...s"
```
Then open `http://<public-ip>:8000/docs` and `http://<public-ip>:8000/v1/model`.

## Troubleshooting
| Symptom | Fix |
|---|---|
| worker log `NoCredentialsError` / `Unable to locate credentials` | hop limit not 2, or role not attached: EC2 → Actions → Security → Modify IAM role / Instance settings → Modify instance metadata options |
| `AccessDenied` on `aliases/latest.json` | role policy bucket name / prefix |
| `/docs` does not open | security group port 8000, or use `http://` (not https) |
| build killed / out of memory | swap is created by the script; or use a bigger instance |

## Useful commands on the instance
```bash
docker compose ps
docker compose logs -f api worker
docker compose up -d --scale worker=2      # more workers
docker compose exec redis redis-cli LLEN inference   # queue length
git pull && docker compose up -d --build   # deploy new code
```
Stop the instance when you are done to avoid charges.
