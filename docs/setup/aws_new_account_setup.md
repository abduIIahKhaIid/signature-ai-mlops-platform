# Move SignatureAI to a new AWS account (every IAM user, role and policy, step by step)

Use this when the code has to run in **another AWS account** (new free tier, company account, the supervisor's
account). It lists every AWS resource the project uses, the exact policy JSON for each identity, and the order to
create them. Two ways to do it:

* **Script (≈ 15 min):** `infra/aws/setup_aws.sh` creates everything with the AWS CLI. Steps 1–6 below say which
  sub-command does what.
* **Console (≈ 45 min):** follow the console clicks in each step. The result is the same.

Placeholders used below. Write your values into `infra/aws/aws.env` (copy of `aws.env.example`, git-ignored):

| Placeholder | Example | Where you get it |
|---|---|---|
| `<ACCOUNT_ID>` | `123456789012` | AWS console, top right |
| `<REGION>` | `ap-southeast-2` (Sydney) | keep bucket, ECR, secret and EC2 in one region |
| `<BUCKET>` | `signatureai-models-ak2026` | S3 names are global: the old name `signatureai-df-detr-models` is taken |
| `<ECR_REPO>` | `signatureai` | |
| `<SECRET_ID>` | `signatureai/prod/dotenv` | |
| `<INSTANCE_ID>` | `i-0abc…` | after step 5 |

`bash infra/aws/render_policies.sh` fills these placeholders into the policy templates and writes ready-to-paste
JSON to `infra/aws/out/rendered/`.

---

## 0. Inventory: what exists in AWS

| # | AWS resource | Name | Used by | Allows |
|---|---|---|---|---|
| 1 | S3 bucket | `<BUCKET>` | everything | model registry: `signatureai/detection/*`, `signatureai/similarity/*` (no datasets) |
| 2 | ECR repository | `signatureai` | CI pushes, EC2 pulls | images `api-<sha>`, `worker-<sha>`, `pipeline-<sha>` |
| 3 | IAM role + instance profile | `SignatureAI-EC2-Role` | the EC2 server (no keys on the server) | policies 3a + 3b |
| 3a | customer managed policy | `SignatureAI-EC2-ReadModels` | role 3 | read models, write aliases/stop files, ECR pull, read the `.env` secret |
| 3b | AWS managed policy | `AmazonSSMManagedInstanceCore` | role 3 | lets SSM (Fleet Manager / Run Command) reach the instance |
| 4 | IAM user (programmatic only) | `signatureai-colab-uploader` | Colab + Kaggle notebooks, synced to Kaggle by EC2 | policy 4a |
| 4a | customer managed policy | `SignatureAI-Notebook-S3` | user 4 | read + write `detection/*` and `similarity/*` only |
| 5 | Secrets Manager secret | `signatureai/prod/dotenv` | `deploy/sync_secrets.sh` on EC2 | the whole server `.env` |
| 6 | EC2 instance | `signatureai-api` t3.large, Ubuntu 24.04, 30 GB gp3 | serves the API | role 3, hop limit 2 |
| 6a | security group | `signatureai-api-sg` | instance 6 | TCP 8000 from anywhere; 22 from your IP (optional); 80/443 for HTTPS (optional) |
| 6b | Elastic IP | — | instance 6 | fixed address for `API_URL` and the HF webhook |
| 6c | key pair | `signatureai-key` | you (SSH) | |
| 7 | IAM user (programmatic only) | `signatureai-github-deployer` | GitHub Actions | policy 7a |
| 7a | customer managed policy | `SignatureAI-GitHub-Deploy` | user 7 | `ssm:SendCommand` on **one** instance + ECR push to **one** repository |

Outside AWS (no change when only the AWS account changes, but listed so nothing is forgotten):
GitHub secrets/variables, Hugging Face dataset + webhook, Kaggle account (secrets dataset is re-created from `.env`),
Comet workspace, Logfire token, Discord/Slack webhook, Gmail app password.

Never in git: `signature_service/.env`, `infra/aws/aws.env`, `infra/aws/out/` (access keys, `.pem`), `keys/`.

---

## Step 1. S3 bucket (model registry)
**Script:** `bash infra/aws/setup_aws.sh bucket`

**Console:** S3 → Create bucket
1. Name `<BUCKET>`, region `<REGION>`.
2. Object Ownership: **ACLs disabled**. **Block all public access: ON**.
3. Bucket Versioning: **Enable** (protects aliases against accidental overwrites).
4. Default encryption: **SSE-S3**. Create.

Folder layout (created by the notebooks, nothing to create by hand):
```
signatureai/detection/versions/<v>/artifact.zip + manifest.json      immutable model versions
signatureai/detection/aliases/latest.json | production.json           which version is candidate / served
signatureai/detection/checkpoints/<v>/                                 training backups
signatureai/detection/pipeline_runs/{live,control,datasets}/           retraining progress, stop files, "trained" markers
signatureai/similarity/versions/<v>/*.pt + gate.json
signatureai/similarity/aliases/latest.json | production.json
```

### 1b. Bring the trained models across (otherwise the new server has no model)
The registry only stores S3 **keys**, never the bucket name, so a plain copy works.
```bash
# with credentials of the OLD account (any key that can read the old bucket)
aws s3 sync s3://signatureai-df-detr-models/signatureai ./s3-backup/signatureai --exclude "*/checkpoints/*"
# with credentials of the NEW account
aws s3 sync ./s3-backup/signatureai s3://<BUCKET>/signatureai
```
No access to the old account any more? Run `notebooks/01_detection_training_colab.ipynb` (detector) and
`notebooks/03_similarity_same_dataset_kaggle.ipynb` (similarity) once with the new keys from step 3b, then promote
both candidates on `/pipeline` (see [`model_promotion.md`](model_promotion.md)).

---

## Step 2. ECR repository (CI builds the images once, EC2 only pulls)
**Script:** `bash infra/aws/setup_aws.sh ecr`

**Console:** ECR → Private registry → Repositories → Create repository → name `signatureai`, **Scan on push: on**.
Then the repository → Lifecycle policy → paste `infra/aws/ecr-lifecycle-policy.json` (keeps the newest 30 images).

CLI equivalent:
```bash
aws ecr create-repository --repository-name signatureai --region <REGION> --image-scanning-configuration scanOnPush=true
aws ecr put-lifecycle-policy --repository-name signatureai --region <REGION> \
  --lifecycle-policy-text file://infra/aws/ecr-lifecycle-policy.json
```

---

## Step 3. IAM: EC2 role and notebook user
**Script:** `bash infra/aws/setup_aws.sh iam`

### 3a. Policy `SignatureAI-EC2-ReadModels`
IAM → Policies → **Create policy** → JSON → paste (template: `infra/aws/policies/ec2-role-policy.json`) → name
`SignatureAI-EC2-ReadModels` → Create.
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "ListModelRegistry", "Effect": "Allow", "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<BUCKET>",
      "Condition": { "StringLike": { "s3:prefix": ["signatureai/detection/*", "signatureai/similarity/*"] } } },
    { "Sid": "ReadModels", "Effect": "Allow", "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::<BUCKET>/signatureai/detection/*",
                   "arn:aws:s3:::<BUCKET>/signatureai/similarity/*"] },
    { "Sid": "PipelineDashboardActions", "Effect": "Allow", "Action": ["s3:PutObject"],
      "Resource": ["arn:aws:s3:::<BUCKET>/signatureai/detection/aliases/*",
                   "arn:aws:s3:::<BUCKET>/signatureai/detection/pipeline_runs/control/*",
                   "arn:aws:s3:::<BUCKET>/signatureai/similarity/aliases/*"] },
    { "Sid": "EcrLogin", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Sid": "EcrPullServiceImages", "Effect": "Allow",
      "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
      "Resource": "arn:aws:ecr:<REGION>:<ACCOUNT_ID>:repository/signatureai" },
    { "Sid": "ReadProductionDotenv", "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:signatureai/prod/dotenv-*" }
  ]
}
```
Why each statement: workers download models (`ReadModels`), the dashboard's Promote / Roll back / Stop write an alias
or a stop file (`PipelineDashboardActions`), the deploy pulls images (`Ecr*`) and fetches `.env` (`ReadProductionDotenv`;
the `-*` matches the 6 random characters AWS adds to secret ARNs).

### 3b. Role `SignatureAI-EC2-Role`
IAM → Roles → **Create role**
1. Trusted entity: **AWS service → EC2** (= `infra/aws/trust/ec2-trust-policy.json`).
2. Permissions: tick **`SignatureAI-EC2-ReadModels`** and **`AmazonSSMManagedInstanceCore`**.
3. Name **`SignatureAI-EC2-Role`** → Create. (The console creates the instance profile with the same name.)

Only if you set `STORAGE_BACKEND=s3` (several EC2 hosts share uploads): also attach a policy made from
`infra/aws/policies/ec2-uploads-s3-optional-policy.json`. The default `local` volume needs nothing.

### 3c. Notebook user `signatureai-colab-uploader`
1. IAM → Policies → Create policy → JSON (template `infra/aws/policies/notebook-uploader-policy.json`) → name
   `SignatureAI-Notebook-S3`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "ListModelRegistry", "Effect": "Allow", "Action": ["s3:ListBucket"],
         "Resource": "arn:aws:s3:::<BUCKET>",
         "Condition": { "StringLike": { "s3:prefix": ["signatureai/detection/*", "signatureai/similarity/*"] } } },
       { "Sid": "ReadWriteModelsRunsAndAliases", "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"],
         "Resource": ["arn:aws:s3:::<BUCKET>/signatureai/detection/*",
                      "arn:aws:s3:::<BUCKET>/signatureai/similarity/*"] }
     ]
   }
   ```
2. IAM → Users → **Create user** `signatureai-colab-uploader`, **no** console access → Attach policies directly →
   `SignatureAI-Notebook-S3` → Create.
3. The user → Security credentials → **Create access key** → *Application running outside AWS* → save both values.
   (The script saves them to `infra/aws/out/signatureai-colab-uploader-access-key.json`.)

This key goes into: Colab Secrets (notebook 01), Kaggle secrets (notebooks 03/04), and `NOTEBOOK_AWS_ACCESS_KEY_ID` /
`NOTEBOOK_AWS_SECRET_ACCESS_KEY` in the server `.env` (EC2 then syncs it to the private Kaggle secrets dataset before
every retraining run). It has **no** delete right and cannot touch anything outside the two model prefixes.

---

## Step 4. Secrets Manager: the server `.env`
**Script:** `bash infra/aws/setup_aws.sh secret` (reads `signature_service/.env`)

1. Make `signature_service/.env` from `.env.example`. For the new account change:
   `MODEL_S3_BUCKET=<BUCKET>`, `NOTEBOOK_AWS_ACCESS_KEY_ID/SECRET` (step 3c), `NOTEBOOK_AWS_REGION=<REGION>`.
   Keep `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` **empty** (the EC2 role is used). Copy the other keys
   (HF, Kaggle, Comet, Logfire, admin token, webhook secret, alerts) from the old `.env`.
2. Secrets Manager → **Store a new secret** → *Other type of secret* → **Plaintext** tab → paste the whole `.env`
   → name **`signatureai/prod/dotenv`** → no rotation → Store.

CLI: `aws secretsmanager create-secret --name signatureai/prod/dotenv --secret-string file://signature_service/.env`

Later changes: edit the secret (Retrieve → Edit), then GitHub → Actions → CI/CD → Run workflow → *force_deploy*.
`deploy/sync_secrets.sh` validates the file before it replaces `.env` on the server.

---

## Step 5. EC2 instance
**Script:** `bash infra/aws/setup_aws.sh ec2` (security group, key pair, instance, Elastic IP; writes `INSTANCE_ID`
and `ELASTIC_IP` into `aws.env`)

**Console:** follow [`deploy_ec2.md`](deploy_ec2.md) section 2, with these values:
* AMI Ubuntu Server 24.04 LTS x86_64, type **t3.large**, storage **30 GB gp3**
* Security group: **TCP 8000 from 0.0.0.0/0**; SSH 22 from **My IP** only (optional)
* Advanced details → IAM instance profile **`SignatureAI-EC2-Role`**
* Advanced details → **Metadata response hop limit 2** (otherwise boto3 inside Docker gets no role credentials)
* Advanced details → User data: `signature_service/deploy/ec2_user_data.sh` (change `REPO_URL` if the repo moved)
Then EC2 → **Elastic IPs → Allocate → Associate** with the instance.

Wait 10–15 minutes, then:
* Systems Manager → **Fleet Manager**: the instance is **Online** (needed for the GitHub deploy).
* `http://<elastic-ip>:8000/health` answers, `/v1/model` shows the model from step 1b.

---

## Step 6. GitHub deploy user `signatureai-github-deployer`
**Script:** `bash infra/aws/setup_aws.sh deployer` (needs `INSTANCE_ID`)

1. IAM → Policies → Create policy → JSON (template `infra/aws/policies/github-deployer-policy.json`, put the real
   `<INSTANCE_ID>`) → name `SignatureAI-GitHub-Deploy`:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Sid": "RunDeployCommandOnTheApiInstanceOnly", "Effect": "Allow", "Action": "ssm:SendCommand",
         "Resource": ["arn:aws:ec2:<REGION>:<ACCOUNT_ID>:instance/<INSTANCE_ID>",
                      "arn:aws:ssm:<REGION>::document/AWS-RunShellScript"] },
       { "Sid": "ReadCommandResults", "Effect": "Allow",
         "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"], "Resource": "*" },
       { "Sid": "EcrLogin", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
       { "Sid": "EcrPushServiceImages", "Effect": "Allow",
         "Action": ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                    "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
         "Resource": "arn:aws:ecr:<REGION>:<ACCOUNT_ID>:repository/signatureai" }
     ]
   }
   ```
2. IAM → Users → Create user `signatureai-github-deployer`, no console access → attach `SignatureAI-GitHub-Deploy`.
3. Security credentials → Create access key → *Application running outside AWS*.

If the instance is ever replaced, only the `<INSTANCE_ID>` in this policy and the GitHub secret `EC2_INSTANCE_ID` change.

---

## Step 7. Outside AWS: point everything at the new account
`bash infra/aws/setup_aws.sh summary` prints this list with your values.

| Where | Name | New value |
|---|---|---|
| GitHub → Settings → Secrets and variables → Actions → **Secrets** | `DEPLOY_AWS_ACCESS_KEY_ID`, `DEPLOY_AWS_SECRET_ACCESS_KEY` | step 6 key |
| | `EC2_INSTANCE_ID` | `i-0…` |
| | `AWS_REGION` | `<REGION>` |
| GitHub → **Variables** | `ECR_REPOSITORY` | `signatureai` |
| | `API_URL` | `http://<elastic-ip>:8000` (no trailing `/`) |
| Hugging Face → Settings → Webhooks | URL | `http://<elastic-ip>:8000/webhooks/huggingface` (secret unchanged) |
| Colab Secrets (notebook 01) | `AWS_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `<BUCKET>`, `<REGION>`, step 3c key |
| Kaggle notebooks 03/04 secrets | same four | same |
| `README.md`, `signature_service/web/vite.config.ts` comment | live URL | new Elastic IP |
| `signature_service/deploy/iam-*.json` (copies the docs refer to) | | `bash infra/aws/render_policies.sh --update-deploy` |

## Step 8. Check that everything works
1. Push a small change under `signature_service/` → GitHub Actions: CI green, `docker-build` shows `📦 Pushed`,
   deploy shows `✅ Deployed <sha>`.
2. `http://<elastic-ip>:8000/health` → `"version"` = that commit.
3. Web app: Detect a document, Verify two signatures.
4. `/pipeline` → *Models on the workers*: both production releases show a gate badge.
5. `/pipeline` → **Check for new data** (admin token): decision appears (e.g. *Already trained*), no *Blocked*.

## Step 9. Clean up the old account (when the new one works)
Old account: stop/terminate the EC2 instance, **release the Elastic IP** (an unattached EIP is billed), delete the
two IAM users' access keys, empty + delete the S3 bucket and the ECR repository, delete the secret.

## Troubleshooting (new account specific)
| Symptom | Cause |
|---|---|
| `AccessDenied` on `aliases/production.json` | `<BUCKET>` in policy 3a differs from `MODEL_S3_BUCKET` in `.env` |
| worker log `NoCredentialsError` | instance profile not attached, or metadata hop limit is 1 |
| deploy: `AccessDeniedException ssm:SendCommand` | `<INSTANCE_ID>` / `<ACCOUNT_ID>` / `<REGION>` wrong in policy 7a |
| deploy: `InvalidInstanceId` | instance not *Online* in Fleet Manager: `AmazonSSMManagedInstanceCore` missing on the role |
| `could not fetch the secret` on first boot | secret created in another region, or name not `signatureai/prod/dotenv` |
| notebook `AccessDenied ... PutObject` | Colab/Kaggle still use the old account's key, or `AWS_S3_BUCKET` is the old bucket |
| `/v1/model` shows no model | step 1b skipped: the new bucket is empty |
