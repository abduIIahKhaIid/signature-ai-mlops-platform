#!/usr/bin/env bash
# Put redis-server on PATH for the CI tests (signature_service/tests/test_e2e.py, pipeline/mock/run_mock_orchestrator.py).
#
# First choice: copy the binary out of the official Redis Docker image. That needs only Docker Hub, not the Ubuntu
# apt mirror, which on GitHub runners sometimes cannot even be resolved ("Temporary failure resolving
# 'azure.archive.ubuntu.com'") and then hangs a job for 7 minutes before failing.
# Fallback: apt, with a time limit per attempt and three attempts.
set -euo pipefail

if command -v redis-server >/dev/null 2>&1; then
  redis-server --version
  exit 0
fi

IMAGE="${REDIS_IMAGE:-redis:7.4-bookworm}"
if cid="$(timeout 180 docker create "$IMAGE" 2>/dev/null)"; then
  sudo docker cp "$cid:/usr/local/bin/redis-server" /usr/local/bin/redis-server
  docker rm "$cid" >/dev/null
  if redis-server --version; then
    echo "redis-server taken from the Docker image $IMAGE"
    exit 0
  fi
  sudo rm -f /usr/local/bin/redis-server
fi

echo "::warning::could not take redis-server from the Docker image $IMAGE; trying apt"
for attempt in 1 2 3; do
  if sudo timeout 120 apt-get update -qq && sudo timeout 180 apt-get install -y -qq redis-server; then
    redis-server --version
    exit 0
  fi
  echo "apt attempt ${attempt} failed"
  sleep 15
done
echo "::error::redis-server could not be installed (Docker Hub and the apt mirror both failed)"
exit 1
