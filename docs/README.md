# Documentation

Start here: [`PROJECT_STATUS.md`](PROJECT_STATUS.md) (requirement checklist, what is still open).

## architecture/ — diagrams
[`architecture/aws/`](architecture/aws/): AWS-icon diagrams: [system on AWS](architecture/aws/aws_architecture.png),
[IAM: who can do what](architecture/aws/aws_iam_access.png), [the two automated flows](architecture/aws/aws_flows.png).
[`architecture/README.md`](architecture/README.md): system architecture, detection request, continuous training, CI/CD, run lifecycle, model registry, validation gate, training notebook.

## setup/ — how to set things up
| File | What |
|---|---|
| [`aws_new_account_setup.md`](setup/aws_new_account_setup.md) | Move to another AWS account: every IAM user, role, policy, bucket, secret, step by step (console or `infra/aws/setup_aws.sh`) |
| [`cicd_github_secrets.md`](setup/cicd_github_secrets.md) | Every push to `main` deploys to EC2: GitHub secrets, SSM, IAM, troubleshooting |
| [`deploy_ec2.md`](setup/deploy_ec2.md) | Create the EC2 server from zero (IAM role, instance, user data) |
| [`retraining_pipeline.md`](setup/retraining_pipeline.md) | Continuous training: HF webhook → EC2 pipeline worker → Kaggle GPU → gate → S3 → hot reload |
| [`model_promotion.md`](setup/model_promotion.md) | Candidate (`latest`) vs served (`production`): gate records, Promote, switching a server to `production` |

## results/ — measured results
| File | What |
|---|---|
| [`phase5_6_ec2_queue_results.md`](results/phase5_6_ec2_queue_results.md) | EC2 deployment checks, queue behaviour, retries, cold start |
| [`phase7_similarity_results.md`](results/phase7_similarity_results.md) | SSIM vs ResNet18 vs Siamese ResNet18 (CEDAR, writer-disjoint) |
| [`phase8_observability.md`](results/phase8_observability.md) | Logfire: what is traced, token rotation, evidence checklist, SQL queries |
| `phase9_stress_test.md` (not generated yet) | Locust stress test 1–40 users and cold start: run `signature_service/loadtest/report.py` (see [`PROJECT_STATUS.md`](PROJECT_STATUS.md)) |
| [`phase10_mock_pipeline_test.md`](results/phase10_mock_pipeline_test.md) | Retraining notebook mock test (all cells, dirty-data checks, gate) |

## images/
Screenshots used as evidence: see [`images/README.md`](images/README.md).
