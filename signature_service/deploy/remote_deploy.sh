#!/bin/bash
# Runs ON the EC2 instance (called by GitHub Actions through AWS SSM Run Command, or by hand).
# Usage: remote_deploy.sh <git-sha>
# The repo has already been reset to <git-sha> by the caller. .env (secrets) is untracked and is kept.
#
# Memory-friendly order for a small instance:
#   1. stop and remove the running containers (volumes kept: Redis queue/pipeline state, model cache)
#   2. free disk/memory: dangling images + old build cache
#   3. build the images ONE AT A TIME (the torch worker image is the heavy one)
#   4. start everything, wait for /ready, check /health reports <git-sha>
# Trade-off: the API is down while images build (~1-3 min with cached layers, longer on a cold cache).
set -euo pipefail
SHA="${1:?usage: remote_deploy.sh <git-sha>}"
SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SERVICE_DIR"
echo "== deploying ${SHA} in ${SERVICE_DIR}"
free -m | sed -n '1,2p'

# Version shown by GET /health, so the pipeline can prove which commit is live
if grep -q '^APP_VERSION=' .env; then
  sed -i "s/^APP_VERSION=.*/APP_VERSION=${SHA}/" .env
else
  echo "APP_VERSION=${SHA}" >> .env
fi

# Optional HTTPS front door (Caddy) only when PUBLIC_HOST is set in .env
PROFILE_ARGS=()
if grep -Eq '^PUBLIC_HOST=.+' .env; then PROFILE_ARGS=(--profile https); fi

echo "== 1/4 stopping running containers (volumes are kept)"
docker compose --profile https down --remove-orphans --timeout 30

echo "== 2/4 freeing space: dangling images + build cache older than 3 days"
docker image prune -f >/dev/null || true
docker builder prune -f --filter until=72h >/dev/null || true

echo "== 3/4 building images one at a time"
for service in api worker pipeline; do
  echo "-- build ${service}"
  docker compose build "${service}"
done

echo "== 4/4 starting: redis api worker pipeline ${PROFILE_ARGS[*]:+(+ https)}"
docker compose "${PROFILE_ARGS[@]}" up -d --remove-orphans

echo "== waiting for /ready (API up, Redis reachable, worker online with models loaded)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 http://localhost:8000/ready >/dev/null 2>&1; then
    HEALTH="$(curl -fsS --max-time 5 http://localhost:8000/health)"
    echo "== ready after ~$((i * 5))s: ${HEALTH}"
    case "$HEALTH" in
      *"\"version\":\"${SHA}\""*) ;;
      *) echo "!! /health does not report ${SHA}"; exit 1 ;;
    esac
    if ! docker compose ps --status running --services | grep -qx pipeline; then
      echo "!! pipeline (retraining orchestrator) container is not running"
      docker compose logs --tail 40 pipeline
      exit 1
    fi
    docker image prune -f >/dev/null || true   # old image versions left untagged by the new build
    docker compose ps
    free -m | sed -n '1,2p'
    echo "DEPLOY_OK ${SHA}"
    exit 0
  fi
  sleep 5
done

echo "!! service not ready after 5 minutes"
docker compose ps
docker compose logs --tail 60 api worker pipeline
exit 1
