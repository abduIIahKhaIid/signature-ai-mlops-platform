#!/usr/bin/env bash
# Create every AWS resource SignatureAI needs in a NEW AWS account, with the AWS CLI.
# Safe to run again: existing resources are kept, policies get a new default version.
#
# Run it from AWS CloudShell (already logged in as an admin) or from a PC with an admin profile:
#   git clone <this repo> && cd <repo>
#   cp infra/aws/aws.env.example infra/aws/aws.env && nano infra/aws/aws.env
#   bash infra/aws/setup_aws.sh all          # = bucket ecr iam secret ec2 deployer
#
# Or step by step (same order as docs/setup/aws_new_account_setup.md):
#   bash infra/aws/setup_aws.sh bucket       # 1. S3 model registry (private, encrypted, versioned)
#   bash infra/aws/setup_aws.sh ecr          # 2. ECR repository + lifecycle (keep 30 images)
#   bash infra/aws/setup_aws.sh iam          # 3. EC2 role + instance profile, notebook IAM user + access key
#   bash infra/aws/setup_aws.sh secret       # 4. Secrets Manager secret = the server .env
#   bash infra/aws/setup_aws.sh ec2          # 5. security group, key pair, EC2 instance, Elastic IP
#   bash infra/aws/setup_aws.sh deployer     # 6. GitHub deploy IAM user + access key (needs INSTANCE_ID)
#   bash infra/aws/setup_aws.sh summary      # what to paste into GitHub / .env
#
# Access keys and the SSH key are written to infra/aws/out/ (git-ignored, chmod 600). They are never printed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
ENV_FILE="${AWS_SETUP_ENV:-${HERE}/aws.env}"
OUT="${HERE}/out"
RENDERED="${OUT}/rendered"
export AWS_PAGER=""
umask 077

[[ -f "${ENV_FILE}" ]] || { echo "ERROR: ${ENV_FILE} not found (copy aws.env.example)" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source <(sed 's/\r$//' "${ENV_FILE}")   # tolerate Windows line endings
set +a
export AWS_DEFAULT_REGION="${AWS_REGION}"
mkdir -p "${OUT}"

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   ✓ %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

check_account() {
  command -v aws >/dev/null || die "AWS CLI v2 is not installed"
  local actual
  actual="$(aws sts get-caller-identity --query Account --output text)" || die "AWS CLI is not logged in"
  [[ "${actual}" == "${AWS_ACCOUNT_ID}" ]] || die "logged in to account ${actual}, but aws.env says ${AWS_ACCOUNT_ID}"
  ok "logged in to account ${actual}, region ${AWS_REGION}"
}

set_env_value() {  # set_env_value KEY VALUE  → writes KEY=VALUE into aws.env
  local key="$1" value="$2"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}" && rm -f "${ENV_FILE}.bak"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
  export "${key}=${value}"
}

render() { bash "${HERE}/render_policies.sh" >/dev/null; }

# Create a customer managed policy, or add a new default version if it exists (max 5 versions kept).
upsert_policy() {  # upsert_policy NAME FILE  → prints ARN
  local name="$1" file="$2" arn="arn:aws:iam::${AWS_ACCOUNT_ID}:policy/$1"
  if aws iam get-policy --policy-arn "${arn}" >/dev/null 2>&1; then
    local old
    old="$(aws iam list-policy-versions --policy-arn "${arn}" \
            --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)"
    # shellcheck disable=SC2206
    local versions=(${old})
    if (( ${#versions[@]} >= 4 )); then
      aws iam delete-policy-version --policy-arn "${arn}" --version-id "${versions[-1]}"
    fi
    aws iam create-policy-version --policy-arn "${arn}" --policy-document "file://${file}" --set-as-default >/dev/null
    ok "policy ${name}: new default version" >&2
  else
    aws iam create-policy --policy-name "${name}" --policy-document "file://${file}" >/dev/null
    ok "policy ${name}: created" >&2
  fi
  echo "${arn}"
}

ensure_user_with_key() {  # ensure_user_with_key USER POLICY_ARN
  local user="$1" arn="$2" keyfile="${OUT}/$1-access-key.json"
  aws iam get-user --user-name "${user}" >/dev/null 2>&1 \
    || { aws iam create-user --user-name "${user}" >/dev/null; ok "user ${user}: created"; }
  aws iam attach-user-policy --user-name "${user}" --policy-arn "${arn}"
  ok "user ${user}: policy attached (no console access)"
  if [[ -s "${keyfile}" ]]; then
    ok "user ${user}: access key already saved in ${keyfile}"
  else
    aws iam create-access-key --user-name "${user}" --output json >"${keyfile}"
    chmod 600 "${keyfile}"
    ok "user ${user}: NEW access key saved to ${keyfile} (open it once, copy, keep it private)"
  fi
}

step_bucket() {
  log "1. S3 bucket ${BUCKET} (model registry)"
  if aws s3api head-bucket --bucket "${BUCKET}" 2>/dev/null; then
    ok "bucket exists"
  else
    if [[ "${AWS_REGION}" == "us-east-1" ]]; then
      aws s3api create-bucket --bucket "${BUCKET}" >/dev/null
    else
      aws s3api create-bucket --bucket "${BUCKET}" \
        --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
    fi
    ok "bucket created"
  fi
  aws s3api put-public-access-block --bucket "${BUCKET}" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption --bucket "${BUCKET}" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-versioning --bucket "${BUCKET}" --versioning-configuration Status=Enabled
  ok "public access blocked, SSE-S3 encryption on, versioning on"
}

step_ecr() {
  log "2. ECR repository ${ECR_REPO}"
  if aws ecr describe-repositories --repository-names "${ECR_REPO}" >/dev/null 2>&1; then
    ok "repository exists"
  else
    aws ecr create-repository --repository-name "${ECR_REPO}" \
      --image-scanning-configuration scanOnPush=true >/dev/null
    ok "repository created (scan on push)"
  fi
  aws ecr put-lifecycle-policy --repository-name "${ECR_REPO}" \
    --lifecycle-policy-text "file://${HERE}/ecr-lifecycle-policy.json" >/dev/null
  ok "lifecycle: keep newest 30 images"
}

step_iam() {
  render
  log "3a. EC2 role ${EC2_ROLE} + instance profile"
  if ! aws iam get-role --role-name "${EC2_ROLE}" >/dev/null 2>&1; then
    aws iam create-role --role-name "${EC2_ROLE}" \
      --assume-role-policy-document "file://${HERE}/trust/ec2-trust-policy.json" \
      --description "SignatureAI EC2: read models, write aliases/control, ECR pull, read .env secret, SSM" >/dev/null
    ok "role created (trusted entity: ec2.amazonaws.com)"
  else
    ok "role exists"
  fi
  local ec2_arn
  ec2_arn="$(upsert_policy "${EC2_POLICY}" "${RENDERED}/ec2-role-policy.json")"
  aws iam attach-role-policy --role-name "${EC2_ROLE}" --policy-arn "${ec2_arn}"
  aws iam attach-role-policy --role-name "${EC2_ROLE}" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  ok "attached ${EC2_POLICY} + AmazonSSMManagedInstanceCore"
  if ! aws iam get-instance-profile --instance-profile-name "${EC2_ROLE}" >/dev/null 2>&1; then
    aws iam create-instance-profile --instance-profile-name "${EC2_ROLE}" >/dev/null
    aws iam add-role-to-instance-profile --instance-profile-name "${EC2_ROLE}" --role-name "${EC2_ROLE}"
    ok "instance profile ${EC2_ROLE} created"
  else
    ok "instance profile exists"
  fi

  log "3b. Notebook IAM user ${NOTEBOOK_USER} (Colab / Kaggle write models to S3)"
  local nb_arn
  nb_arn="$(upsert_policy "${NOTEBOOK_POLICY}" "${RENDERED}/notebook-uploader-policy.json")"
  ensure_user_with_key "${NOTEBOOK_USER}" "${nb_arn}"
}

step_secret() {
  log "4. Secrets Manager ${SECRET_ID} (the whole server .env)"
  local src="${SECRET_DOTENV:-${REPO}/signature_service/.env}"
  [[ -s "${src}" ]] || die "${src} not found. Fill signature_service/.env (from .env.example) first, or set SECRET_DOTENV=path"
  grep -qE "^MODEL_S3_BUCKET=${BUCKET}"$'\r?$' "${src}" \
    || die "${src}: MODEL_S3_BUCKET must be ${BUCKET} (the new bucket)"
  if grep -qE '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)=.+' "${src}"; then
    die "${src}: leave AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY empty on EC2 (the instance role is used)"
  fi
  if aws secretsmanager describe-secret --secret-id "${SECRET_ID}" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "${SECRET_ID}" --secret-string "file://${src}" >/dev/null
    ok "secret updated from ${src}"
  else
    aws secretsmanager create-secret --name "${SECRET_ID}" --secret-string "file://${src}" \
      --description "SignatureAI production .env (read by deploy/sync_secrets.sh on EC2)" >/dev/null
    ok "secret created from ${src}"
  fi
}

step_ec2() {
  log "5. EC2 ${INSTANCE_NAME} (${INSTANCE_TYPE}, Ubuntu 24.04, role ${EC2_ROLE})"
  if [[ -n "${INSTANCE_ID:-}" ]]; then ok "INSTANCE_ID=${INSTANCE_ID} already set: skipping launch"; return; fi
  aws secretsmanager describe-secret --secret-id "${SECRET_ID}" >/dev/null 2>&1 \
    || die "run 'secret' first: the user data reads .env from Secrets Manager on first boot"

  local vpc sg ami
  vpc="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
  [[ "${vpc}" != "None" ]] || die "no default VPC in ${AWS_REGION}: create one (VPC → Actions → Create default VPC)"
  sg="$(aws ec2 describe-security-groups --filters Name=group-name,Values="${SECURITY_GROUP}" Name=vpc-id,Values="${vpc}" \
        --query 'SecurityGroups[0].GroupId' --output text)"
  if [[ "${sg}" == "None" ]]; then
    sg="$(aws ec2 create-security-group --group-name "${SECURITY_GROUP}" --vpc-id "${vpc}" \
          --description "SignatureAI API" --query GroupId --output text)"
    aws ec2 authorize-security-group-ingress --group-id "${sg}" --protocol tcp --port 8000 --cidr 0.0.0.0/0 >/dev/null
    if [[ -n "${SSH_CIDR:-}" ]]; then
      aws ec2 authorize-security-group-ingress --group-id "${sg}" --protocol tcp --port 22 --cidr "${SSH_CIDR}" >/dev/null
    fi
    if [[ "${OPEN_HTTPS:-false}" == "true" ]]; then
      aws ec2 authorize-security-group-ingress --group-id "${sg}" --protocol tcp --port 80  --cidr 0.0.0.0/0 >/dev/null
      aws ec2 authorize-security-group-ingress --group-id "${sg}" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
    fi
    ok "security group ${sg}: 8000 open${SSH_CIDR:+, 22 from ${SSH_CIDR}}"
  else
    ok "security group ${sg} exists"
  fi

  if ! aws ec2 describe-key-pairs --key-names "${KEY_NAME}" >/dev/null 2>&1; then
    aws ec2 create-key-pair --key-name "${KEY_NAME}" --query KeyMaterial --output text >"${OUT}/${KEY_NAME}.pem"
    chmod 400 "${OUT}/${KEY_NAME}.pem"
    ok "key pair ${KEY_NAME} → ${OUT}/${KEY_NAME}.pem"
  fi

  ami="$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
         --query Parameter.Value --output text)"
  sleep 10  # a just-created instance profile needs a few seconds before EC2 accepts it
  local id
  id="$(aws ec2 run-instances --image-id "${ami}" --instance-type "${INSTANCE_TYPE}" \
        --key-name "${KEY_NAME}" --security-group-ids "${sg}" \
        --iam-instance-profile "Name=${EC2_ROLE}" \
        --metadata-options HttpEndpoint=enabled,HttpTokens=required,HttpPutResponseHopLimit=2 \
        --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=${DISK_GB},VolumeType=gp3}" \
        --user-data "file://${REPO}/signature_service/deploy/ec2_user_data.sh" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}}]" \
        --query 'Instances[0].InstanceId' --output text)"
  set_env_value INSTANCE_ID "${id}"
  ok "instance ${id} launched (hop limit 2, IMDSv2), waiting for running…"
  aws ec2 wait instance-running --instance-ids "${id}"

  local alloc ip
  alloc="$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)"
  aws ec2 associate-address --instance-id "${id}" --allocation-id "${alloc}" >/dev/null
  ip="$(aws ec2 describe-addresses --allocation-ids "${alloc}" --query 'Addresses[0].PublicIp' --output text)"
  set_env_value ELASTIC_IP "${ip}"
  ok "Elastic IP ${ip} attached. First boot takes 10–15 min: http://${ip}:8000/health"
}

step_deployer() {
  [[ -n "${INSTANCE_ID:-}" ]] || die "INSTANCE_ID is empty: run 'ec2' first or paste the i-0… id into aws.env"
  render
  log "6. GitHub deploy IAM user ${DEPLOYER_USER} (SSM on ${INSTANCE_ID} + ECR push only)"
  local arn
  arn="$(upsert_policy "${DEPLOYER_POLICY}" "${RENDERED}/github-deployer-policy.json")"
  ensure_user_with_key "${DEPLOYER_USER}" "${arn}"
}

step_summary() {
  log "What to paste where"
  cat <<EOF
GitHub → Settings → Secrets and variables → Actions
  Secret   DEPLOY_AWS_ACCESS_KEY_ID      = AccessKeyId     in ${OUT}/${DEPLOYER_USER}-access-key.json
  Secret   DEPLOY_AWS_SECRET_ACCESS_KEY  = SecretAccessKey in ${OUT}/${DEPLOYER_USER}-access-key.json
  Secret   EC2_INSTANCE_ID               = ${INSTANCE_ID:-<run ec2>}
  Secret   AWS_REGION                    = ${AWS_REGION}
  Variable ECR_REPOSITORY                = ${ECR_REPO}
  Variable API_URL                       = http://${ELASTIC_IP:-<elastic-ip>}:8000

signature_service/.env (then: bash infra/aws/setup_aws.sh secret, and redeploy)
  MODEL_S3_BUCKET                = ${BUCKET}
  NOTEBOOK_AWS_ACCESS_KEY_ID     = AccessKeyId     in ${OUT}/${NOTEBOOK_USER}-access-key.json
  NOTEBOOK_AWS_SECRET_ACCESS_KEY = SecretAccessKey in ${OUT}/${NOTEBOOK_USER}-access-key.json
  NOTEBOOK_AWS_REGION            = ${AWS_REGION}

Colab / Kaggle secrets of the notebooks
  AWS_S3_BUCKET=${BUCKET}  AWS_REGION=${AWS_REGION}  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY = ${NOTEBOOK_USER} key

Hugging Face webhook URL  http://${ELASTIC_IP:-<elastic-ip>}:8000/webhooks/huggingface
EOF
}

cmd="${1:-}"
case "${cmd}" in
  bucket)   check_account; step_bucket ;;
  ecr)      check_account; step_ecr ;;
  iam)      check_account; step_iam ;;
  secret)   check_account; step_secret ;;
  ec2)      check_account; step_ec2 ;;
  deployer) check_account; step_deployer ;;
  summary)  step_summary ;;
  all)      check_account; step_bucket; step_ecr; step_iam; step_secret; step_ec2; step_deployer; step_summary ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
