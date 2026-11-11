# infra/aws — everything AWS, as code

| File | What |
|---|---|
| `aws.env.example` | account ID, region, bucket and IAM names. Copy to `aws.env` (git-ignored). |
| `policies/ec2-role-policy.json` | policy of the EC2 role `SignatureAI-EC2-Role` |
| `policies/notebook-uploader-policy.json` | policy of the IAM user `signatureai-colab-uploader` (Colab / Kaggle notebooks) |
| `policies/github-deployer-policy.json` | policy of the IAM user `signatureai-github-deployer` (GitHub Actions) |
| `policies/ec2-uploads-s3-optional-policy.json` | only for `STORAGE_BACKEND=s3` |
| `trust/ec2-trust-policy.json` | lets EC2 assume the role |
| `ecr-lifecycle-policy.json` | ECR keeps the newest 30 images |
| `render_policies.sh` | fills `__ACCOUNT_ID__`, `__REGION__`, `__BUCKET__`, `__INSTANCE_ID__`… → `out/rendered/` |
| `setup_aws.sh` | creates bucket, ECR, IAM role/users/keys, secret, EC2 + Elastic IP with the AWS CLI |
| `out/` | generated: rendered JSON, access keys, `.pem` (git-ignored, never commit) |

Step-by-step guide (console and script): [`docs/setup/aws_new_account_setup.md`](../../docs/setup/aws_new_account_setup.md).

```bash
cp infra/aws/aws.env.example infra/aws/aws.env    # fill in account ID, region, a new bucket name
bash infra/aws/setup_aws.sh all                   # or one step at a time: bucket ecr iam secret ec2 deployer summary
```

With the original values the templates render to exactly the same policies (same JSON content) as the ones used in
the original account (`signature_service/deploy/iam-*.json`), so nothing is lost when moving accounts.
