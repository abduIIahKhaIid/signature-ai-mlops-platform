#!/bin/bash
# Runs ON the EC2 instance (called by GitHub Actions through AWS SSM Run Command, or by hand).
#
# Usage: remote_deploy.sh <git-sha> [<ecr-image>]
#   <git-sha>    commit to serve. The caller has already reset the repo to it.
#   <ecr-image>  optional, e.g. 433306738386.dkr.ecr.ap-southeast-2.amazonaws.com/signatureai
#                Given:   CI already built and pushed api-<sha>, worker-<sha>, pipeline-<sha> to ECR.
#                         The instance only PULLS them (no build here) and swaps containers: seconds of downtime.
#                Omitted: old behaviour, the images are built on this instance one at a time.
#
# Before stopping anything, the production .env is refreshed from AWS Secrets Manager (deploy/sync_secrets.sh).
# If that fails, nothing is touched and the running version keeps serving.
#
# AUTOMATIC ROLLBACK: the last commit that passed every check is kept in .deployed_sha. If the new version does
# not become ready (or /health reports the wrong commit, or the pipeline container is down), the repo is reset to
# that commit and its images are started again (local images first, then ECR, then a local build). The script
# still exits non-zero, so the CI job is red, but the service stays up on the previous version.
#
# Exit codes: 0 deployed · 1 failed before touching containers, or failed and rolled back · 2 failed and rollback failed
set -euo pipefail

# The rollback runs `git reset` on this repository, which rewrites this very file. Bash reads scripts while it runs
# them, so continue from a private copy.
if [[ -z "${_REMOTE_DEPLOY_COPY:-}" ]]; then
  _SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  _COPY="$(mktemp /tmp/remote_deploy.XXXXXX.sh)"
  cp "$0" "$_COPY"
  _REMOTE_DEPLOY_COPY="$_COPY" SERVICE_DIR="$_SERVICE_DIR" exec bash "$_COPY" "$@"
fi
trap 'rm -f -- "${_REMOTE_DEPLOY_COPY}"' EXIT

SHA="${1:?usage: remote_deploy.sh <git-sha> [<ecr-image>]}"
ECR_IMAGE_ARG="${2:-}"
REPO_DIR="$(cd "${SERVICE_DIR}/.." && pwd)"
STATE_FILE="${SERVICE_DIR}/.deployed_sha"     # untracked: last commit that passed all checks
LOCAL_IMAGE="signatureai"                      # image name when nothing comes from ECR
SERVICES=(api worker pipeline)
READY_ATTEMPTS="${READY_ATTEMPTS:-60}"         # readiness wait: attempts x READY_SLEEP seconds (default 5 min)
READY_SLEEP="${READY_SLEEP:-5}"
cd "$SERVICE_DIR"
echo "== deploying ${SHA} in ${SERVICE_DIR}${ECR_IMAGE_ARG:+ (images from ${ECR_IMAGE_ARG})}"
free -m | sed -n '1,2p'

# ------------------------------------------------------------------------------------------------ helpers
set_env() {  # set_env KEY VALUE: replace or append one line in .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

git_as_owner() {  # the repo belongs to ubuntu; SSM runs this script as root
  if id ubuntu >/dev/null 2>&1 && [[ "$(id -u)" == "0" ]]; then sudo -u ubuntu git -C "$REPO_DIR" "$@"
  else git -C "$REPO_DIR" "$@"; fi
}

profile_args() {  # optional HTTPS front door (Caddy) only when PUBLIC_HOST is set in .env
  if grep -Eq '^PUBLIC_HOST=.+' .env; then echo "--profile https"; fi
}

ecr_login() {  # ecr_login <registry/repo>: docker login with the instance role (no keys on the server)
  local registry="${1%%/*}" region
  region="$(echo "$registry" | sed -nE 's/^[0-9]+\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/\1/p')"
  if [[ -z "$region" ]]; then echo "!! not an ECR image name: $1" >&2; return 1; fi
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry" >/dev/null
}

local_images_exist() {  # local_images_exist <image> <tag>
  local s
  for s in "${SERVICES[@]}"; do docker image inspect "$1:$s-$2" >/dev/null 2>&1 || return 1; done
}

pull_images() {  # pull_images <image> <tag> (shell variables override .env for this one command)
  ecr_login "$1" || return 1
  ECR_IMAGE="$1" IMAGE_TAG="$2" docker compose pull --quiet "${SERVICES[@]}" || return 1
}

build_images() {  # memory-friendly local build for a small instance
  echo "-- stopping containers before the build (volumes are kept)"
  docker compose --profile https down --remove-orphans --timeout 30 || return 1
  docker image prune -f >/dev/null || true
  docker builder prune -f --filter until=72h >/dev/null || true
  local s
  for s in "${SERVICES[@]}"; do echo "-- build $s"; docker compose build "$s" || return 1; done
}

start_and_verify() {  # start_and_verify <sha>: up, then wait for /ready, /health == sha, pipeline running
  local want="$1" i health
  # shellcheck disable=SC2046
  docker compose $(profile_args) up -d --remove-orphans || return 1
  echo "== waiting for /ready (API up, Redis reachable, worker online with models loaded)"
  for i in $(seq 1 "$READY_ATTEMPTS"); do
    if curl -fsS --max-time 5 http://localhost:8000/ready >/dev/null 2>&1; then
      health="$(curl -fsS --max-time 5 http://localhost:8000/health || true)"
      echo "== ready after ~$((i * READY_SLEEP))s: ${health}"
      case "$health" in
        *"\"version\":\"${want}\""*) ;;
        *) echo "!! /health does not report ${want}"; return 1 ;;
      esac
      if ! docker compose ps --status running --services | grep -qx pipeline; then
        echo "!! pipeline (retraining orchestrator) container is not running"
        docker compose logs --tail 40 pipeline || true
        return 1
      fi
      return 0
    fi
    sleep "$READY_SLEEP"
  done
  echo "!! service not ready after $((READY_ATTEMPTS * READY_SLEEP)) seconds"
  docker compose ps || true
  docker compose logs --tail 60 api worker pipeline || true
  return 1
}

prune_old_tags() {  # keep only the images of <image> tagged for the current and the previous release
  local image="$1" keep_a="$2" keep_b="${3:-}" ref tag
  docker images "$image" --format '{{.Repository}}:{{.Tag}}' | while read -r ref; do
    tag="${ref##*:}"; tag="${tag#*-}"
    if [[ "$tag" != "$keep_a" && "$tag" != "$keep_b" ]]; then docker rmi "$ref" >/dev/null 2>&1 || true; fi
  done
  docker image prune -f >/dev/null || true
}

# ------------------------------------------------------------------------------------------------ 0. previous release
PREV=""
[[ -f "$STATE_FILE" ]] && PREV="$(tr -d '[:space:]' < "$STATE_FILE")"
if [[ -z "$PREV" ]]; then  # first deploy with this script: ask the running API which commit it serves
  PREV="$(curl -fsS --max-time 5 http://localhost:8000/health 2>/dev/null \
          | sed -nE 's/.*"version":"([0-9a-f]{7,40})".*/\1/p' || true)"
fi
PREV_IMAGE="$(sed -nE 's/^ECR_IMAGE=(.+)$/\1/p' .env 2>/dev/null | tail -1)"
PREV_IMAGE="${PREV_IMAGE:-$LOCAL_IMAGE}"
echo "== previous release: ${PREV:-unknown} (${PREV_IMAGE})"

# ------------------------------------------------------------------------------------------------ 1. preflight
# Fetch and validate the new environment before stopping the working deployment.
# If AWS/IAM/secret validation fails, set -e exits here and existing containers stay up.
echo "== 1/4 preflight: synchronizing production environment"
bash "${SERVICE_DIR}/deploy/sync_secrets.sh"

IMAGE="${ECR_IMAGE_ARG:-$LOCAL_IMAGE}"

# ------------------------------------------------------------------------------------------------ 2. images
# ECR: pull while the old containers keep serving. Pull failure = nothing changed yet, plain exit 1.
if [[ -n "$ECR_IMAGE_ARG" ]]; then
  echo "== 2/4 pulling ${IMAGE}:{api,worker,pipeline}-${SHA} (old version keeps serving meanwhile)"
  if ! pull_images "$IMAGE" "$SHA"; then
    echo "!! could not pull the images from ECR: nothing was changed, ${PREV:-the old version} keeps serving"
    exit 1
  fi
else
  echo "== 2/4 building images on this instance (no ECR image given)"
fi
set_env APP_VERSION "$SHA"      # GET /health reports it, so CI can prove which commit is live
set_env ECR_IMAGE "$IMAGE"      # docker-compose.yml: image: ${ECR_IMAGE}:<service>-${IMAGE_TAG}
set_env IMAGE_TAG "$SHA"

# ------------------------------------------------------------------------------------------------ 3. start + verify
echo "== 3/4 starting the new version"
DEPLOY_OK=true
if [[ -z "$ECR_IMAGE_ARG" ]]; then
  build_images || DEPLOY_OK=false
fi
if $DEPLOY_OK && start_and_verify "$SHA"; then
  echo "$SHA" > "$STATE_FILE"
  prune_old_tags "$IMAGE" "$SHA" "$PREV"
  docker compose ps
  free -m | sed -n '1,2p'
  echo "== 4/4 done"
  echo "DEPLOY_OK ${SHA}"
  exit 0
fi

# ------------------------------------------------------------------------------------------------ 4. rollback
echo "!! ${SHA} failed its checks"
if [[ -z "$PREV" || "$PREV" == "$SHA" ]]; then
  echo "!! no earlier healthy release known: cannot roll back"
  exit 2
fi
echo "== 4/4 ROLLING BACK to ${PREV}"
git_as_owner fetch --quiet origin || true
if ! git_as_owner reset --hard "$PREV"; then
  echo "!! git reset to ${PREV} failed: rollback impossible"
  exit 2
fi
set_env APP_VERSION "$PREV"
set_env IMAGE_TAG "$PREV"
if grep -q 'ECR_IMAGE' docker-compose.yml; then
  # the previous commit already uses tagged images: reuse local ones, else pull from ECR, else build
  if local_images_exist "$PREV_IMAGE" "$PREV"; then
    set_env ECR_IMAGE "$PREV_IMAGE"; echo "-- previous images are still on this instance"
  elif [[ "$PREV_IMAGE" != "$LOCAL_IMAGE" ]] && pull_images "$PREV_IMAGE" "$PREV"; then
    set_env ECR_IMAGE "$PREV_IMAGE"; echo "-- previous images pulled from ECR"
  else
    set_env ECR_IMAGE "$LOCAL_IMAGE"; build_images || { echo "!! rebuilding ${PREV} failed"; exit 2; }
  fi
else
  build_images || { echo "!! rebuilding ${PREV} failed"; exit 2; }  # older commit without tagged images
fi
if start_and_verify "$PREV"; then
  # also on stderr: SSM keeps only the first 24 000 characters of stdout, and build logs can be longer
  echo "ROLLED_BACK ${SHA} -> ${PREV}: the previous version is serving again" | tee /dev/stderr
  exit 1
fi
echo "!! rollback to ${PREV} also failed: the service is DOWN, check the logs above"
exit 2
