#!/usr/bin/env bash
# Fetch the production dotenv file from AWS Secrets Manager without printing it.
#
# The secret value must be a complete dotenv file. By default it is read from:
#   region: ap-southeast-2
#   secret: signatureai/prod/dotenv
# Override those locations with SIGNATUREAI_SECRET_REGION / SIGNATUREAI_SECRET_ID.
set -euo pipefail

# Files created by this script must be readable only by their owner.
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${SERVICE_DIR}/.env"
SECRET_REGION="${SIGNATUREAI_SECRET_REGION:-ap-southeast-2}"
SECRET_ID="${SIGNATUREAI_SECRET_ID:-signatureai/prod/dotenv}"

TEMP_ENV=""
BACKUP_ENV=""
HAD_ENV=false

cleanup() {
  if [[ -n "${TEMP_ENV}" && -e "${TEMP_ENV}" ]]; then
    rm -f -- "${TEMP_ENV}"
  fi
  if [[ -n "${BACKUP_ENV}" && -e "${BACKUP_ENV}" ]]; then
    rm -f -- "${BACKUP_ENV}"
  fi
}
trap cleanup EXIT

for command_name in aws docker awk sed mktemp; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "ERROR: required command '${command_name}' is not installed" >&2
    exit 1
  fi
done

cd "${SERVICE_DIR}"

# Avoid two deploys replacing .env at the same time. flock is present on normal
# Ubuntu installations; retain the safety checks even if a minimal image lacks it.
LOCK_FILE="${SERVICE_DIR}/.sync-secrets.lock"
exec 9>"${LOCK_FILE}"
chmod 600 "${LOCK_FILE}"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    echo "ERROR: another secret synchronization is already running" >&2
    exit 1
  fi
fi

TEMP_ENV="$(mktemp "${SERVICE_DIR}/.env.secrets.XXXXXX")"

echo "== fetching production environment from AWS Secrets Manager"
# Never remove the redirection: SecretString must not reach stdout or deployment logs.
AWS_PAGER="" aws secretsmanager get-secret-value \
  --region "${SECRET_REGION}" \
  --secret-id "${SECRET_ID}" \
  --version-stage AWSCURRENT \
  --query SecretString \
  --output text >"${TEMP_ENV}"

if [[ ! -s "${TEMP_ENV}" ]]; then
  echo "ERROR: Secrets Manager returned an empty SecretString" >&2
  exit 1
fi

# Console pastes from Windows may contain CRLF; normalize without displaying data.
sed -i 's/\r$//' "${TEMP_ENV}"

# Accept only blank lines, comments, or KEY=value entries. Do not print a bad line:
# it may contain a secret. The line number alone is safe for troubleshooting.
if ! awk '
  /^[[:space:]]*$/ { next }
  /^[[:space:]]*#/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ { next }
  { bad_line = NR; exit 1 }
  END {
    if (bad_line) {
      printf "ERROR: malformed dotenv entry at line %d\n", bad_line > "/dev/stderr"
      exit 1
    }
  }
' "${TEMP_ENV}"; then
  exit 1
fi

# A duplicate key makes the effective value ambiguous and can hide a bad rotation.
if ! awk -F= '
  /^[A-Za-z_][A-Za-z0-9_]*=/ {
    if (++seen[$1] > 1) duplicate = 1
  }
  END { exit duplicate ? 1 : 0 }
' "${TEMP_ENV}"; then
  echo "ERROR: the secret contains one or more duplicate environment keys" >&2
  exit 1
fi

required_keys=(
  ENVIRONMENT
  MODEL_SOURCE
  MODEL_S3_BUCKET
  MODEL_S3_PREFIX
  MODEL_ALIAS
  AWS_DEFAULT_REGION
  STORAGE_BACKEND
  HF_WEBHOOK_SECRET
  HF_DATASET_REPO
  HF_TOKEN
  KAGGLE_USERNAME
  KAGGLE_KEY
  PIPELINE_ADMIN_TOKEN
  RETRAIN_MODE
  COMET_WORKSPACE
  COMET_PROJECT
  COMET_API_KEY
  NOTEBOOK_AWS_ACCESS_KEY_ID
  NOTEBOOK_AWS_SECRET_ACCESS_KEY
  NOTEBOOK_AWS_REGION
)

missing_keys=()
for key in "${required_keys[@]}"; do
  if ! awk -v wanted="${key}" '
    index($0, wanted "=") == 1 {
      value = substr($0, length(wanted) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (length(value) > 0) found = 1
    }
    END { exit found ? 0 : 1 }
  ' "${TEMP_ENV}"; then
    missing_keys+=("${key}")
  fi
done

if (( ${#missing_keys[@]} > 0 )); then
  echo "ERROR: required variables are missing or empty: ${missing_keys[*]}" >&2
  exit 1
fi

read_env_value() {
  local wanted="$1"
  awk -v wanted="${wanted}" '
    index($0, wanted "=") == 1 {
      print substr($0, length(wanted) + 2)
      exit
    }
  ' "${TEMP_ENV}"
}

# These credentials protect different trust boundaries and must not be reused.
webhook_secret="$(read_env_value HF_WEBHOOK_SECRET)"
admin_token="$(read_env_value PIPELINE_ADMIN_TOKEN)"
if [[ "${webhook_secret}" == "${admin_token}" ]]; then
  echo "ERROR: HF_WEBHOOK_SECRET and PIPELINE_ADMIN_TOKEN must be different" >&2
  exit 1
fi

webhook_secret_length="${#webhook_secret}"
admin_token_length="${#admin_token}"
if (( webhook_secret_length < 32 || admin_token_length < 32 )); then
  echo "ERROR: webhook and admin secrets must each be at least 32 characters" >&2
  exit 1
fi

# Catch the configuration mistake that previously caused Hugging Face to receive
# a different secret: one token accidentally pasted twice back-to-back.
if (( webhook_secret_length % 2 == 0 )); then
  webhook_half_length=$((webhook_secret_length / 2))
  if [[ "${webhook_secret:0:webhook_half_length}" == "${webhook_secret:webhook_half_length}" ]]; then
    echo "ERROR: HF_WEBHOOK_SECRET appears to contain the same value twice" >&2
    exit 1
  fi
fi

hf_dataset_repo="$(read_env_value HF_DATASET_REPO)"
if [[ ! "${hf_dataset_repo}" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo "ERROR: HF_DATASET_REPO must use owner/repository format" >&2
  exit 1
fi

# Production must use the EC2 instance role, never static runtime AWS keys, and
# must not expose the deliberate failure-simulation switch.
environment_name="$(read_env_value ENVIRONMENT)"
environment_name="${environment_name,,}"
if [[ "${environment_name}" == "ec2" || "${environment_name}" == "production" ]]; then
  if [[ -n "$(read_env_value AWS_ACCESS_KEY_ID)" || -n "$(read_env_value AWS_SECRET_ACCESS_KEY)" ]]; then
    echo "ERROR: runtime AWS keys must be empty on EC2; use the instance IAM role" >&2
    exit 1
  fi
  failure_simulation="$(read_env_value ALLOW_FAILURE_SIMULATION)"
  failure_simulation="${failure_simulation,,}"
  if [[ "${failure_simulation}" == "1" || "${failure_simulation}" == "true" ||
        "${failure_simulation}" == "yes" || "${failure_simulation}" == "on" ]]; then
    echo "ERROR: ALLOW_FAILURE_SIMULATION must be false in production" >&2
    exit 1
  fi
fi

# Preserve the existing file's owner when SSM invokes this script as root. When
# there is no prior file, use the owner of the service directory.
if [[ -e "${ENV_FILE}" ]]; then
  HAD_ENV=true
  OWNER_UID="$(stat -c '%u' "${ENV_FILE}")"
  OWNER_GID="$(stat -c '%g' "${ENV_FILE}")"
  BACKUP_ENV="$(mktemp "${SERVICE_DIR}/.env.backup.XXXXXX")"
  cp --preserve=mode,ownership,timestamps -- "${ENV_FILE}" "${BACKUP_ENV}"
else
  OWNER_UID="$(stat -c '%u' "${SERVICE_DIR}")"
  OWNER_GID="$(stat -c '%g' "${SERVICE_DIR}")"
fi

# TEMP_ENV is on the same filesystem, so rename is atomic.
mv -f -- "${TEMP_ENV}" "${ENV_FILE}"
TEMP_ENV=""
chmod 600 "${ENV_FILE}"
if [[ "$(id -u)" -eq 0 ]]; then
  chown "${OWNER_UID}:${OWNER_GID}" "${ENV_FILE}"
fi

# Validate the exact file Docker Compose will consume. If validation fails, put
# the previous file back before returning an error; running containers are untouched.
if ! docker compose config --quiet; then
  echo "ERROR: Docker Compose rejected the synchronized environment; restoring the previous file" >&2
  if [[ "${HAD_ENV}" == true ]]; then
    mv -f -- "${BACKUP_ENV}" "${ENV_FILE}"
    BACKUP_ENV=""
  else
    rm -f -- "${ENV_FILE}"
  fi
  exit 1
fi

if [[ -n "${BACKUP_ENV}" && -e "${BACKUP_ENV}" ]]; then
  rm -f -- "${BACKUP_ENV}"
  BACKUP_ENV=""
fi

echo "== production environment synchronized and validated"
