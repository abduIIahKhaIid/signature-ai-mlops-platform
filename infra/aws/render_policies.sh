#!/usr/bin/env bash
# Fill the IAM policy templates in infra/aws/policies/ with the values of infra/aws/aws.env.
#
#   bash infra/aws/render_policies.sh                    # → infra/aws/out/rendered/*.json (git-ignored)
#   bash infra/aws/render_policies.sh --update-deploy    # also refresh signature_service/deploy/iam-*.json
#
# Paste the rendered JSON into IAM → Policies → Create policy → JSON, or let setup_aws.sh create them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../.." && pwd)"
ENV_FILE="${AWS_SETUP_ENV:-${HERE}/aws.env}"
OUT="${HERE}/out/rendered"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found. Run: cp infra/aws/aws.env.example infra/aws/aws.env  and fill it in." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source <(sed 's/\r$//' "${ENV_FILE}")   # tolerate Windows line endings
set +a

for v in AWS_ACCOUNT_ID AWS_REGION BUCKET ECR_REPO SECRET_ID; do
  if [[ -z "${!v:-}" ]]; then echo "ERROR: ${v} is empty in ${ENV_FILE}" >&2; exit 1; fi
done
if [[ ! "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]]; then
  echo "ERROR: AWS_ACCOUNT_ID must be 12 digits" >&2; exit 1
fi
INSTANCE="${INSTANCE_ID:-<INSTANCE_ID>}"

mkdir -p "${OUT}"
render() {  # render <template> <output>
  sed -e "s|__ACCOUNT_ID__|${AWS_ACCOUNT_ID}|g" \
      -e "s|__REGION__|${AWS_REGION}|g" \
      -e "s|__BUCKET__|${BUCKET}|g" \
      -e "s|__ECR_REPO__|${ECR_REPO}|g" \
      -e "s|__SECRET_ID__|${SECRET_ID}|g" \
      -e "s|__INSTANCE_ID__|${INSTANCE}|g" \
      "$1" >"$2"
  if grep -q "__[A-Z_]*__" "$2"; then
    echo "ERROR: unreplaced placeholder in $2" >&2; exit 1
  fi
}

for t in "${HERE}"/policies/*.json; do
  render "$t" "${OUT}/$(basename "$t")"
  echo "rendered ${OUT}/$(basename "$t")"
done

if [[ "${1:-}" == "--update-deploy" ]]; then
  cp "${OUT}/ec2-role-policy.json"        "${REPO}/signature_service/deploy/iam-ec2-role-policy.json"
  cp "${OUT}/github-deployer-policy.json" "${REPO}/signature_service/deploy/iam-github-deployer-policy.json"
  echo "updated signature_service/deploy/iam-ec2-role-policy.json and iam-github-deployer-policy.json"
fi
if [[ "${INSTANCE}" == "<INSTANCE_ID>" ]]; then
  echo "note: INSTANCE_ID is empty, github-deployer-policy.json still contains <INSTANCE_ID> (fill it after launching EC2)."
fi
