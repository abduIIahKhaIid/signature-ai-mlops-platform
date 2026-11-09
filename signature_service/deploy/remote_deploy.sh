#!/bin/bash
# Runs ON the EC2 instance (called by GitHub Actions through AWS SSM Run Command).
# Usage: remote_deploy.sh <git-sha>
# The repo has already been reset to <git-sha> by the caller. .env (secrets) is untracked and is kept.
set -euo pipefail
SHA="${1:?usage: remote_deploy.sh <git-sha>}"
SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SERVICE_DIR"
echo "== deploying ${SHA} in ${SERVICE_DIR}"

# Version shown by GET /health, so the pipeline can prove which commit is live
if grep -q '^APP_VERSION=' .env; then
  sed -i "s/^APP_VERSION=.*/APP_VERSION=${SHA}/" .env
else
  echo "APP_VERSION=${SHA}" >> .env
fi

docker compose up -d --build --remove-orphans api worker pipeline

echo "== waiting for /ready (API up, Redis reachable, worker online with models loaded)"
for i in $(seq 1 60); do
  if curl -fsS --max-time 5 http://localhost:8000/ready >/dev/null 2>&1; then
    HEALTH="$(curl -fsS --max-time 5 http://localhost:8000/health)"
    echo "== ready after ~$((i * 5))s: ${HEALTH}"
    case "$HEALTH" in
      *"\"version\":\"${SHA}\""*) ;;
      *) echo "!! /health does not report ${SHA}"; exit 1 ;;
    esac
    docker image prune -f >/dev/null || true   # keep the disk from filling up with old layers
    docker compose ps
    echo "DEPLOY_OK ${SHA}"
    exit 0
  fi
  sleep 5
done

echo "!! service not ready after 5 minutes"
docker compose ps
docker compose logs --tail 60 api worker pipeline
exit 1
