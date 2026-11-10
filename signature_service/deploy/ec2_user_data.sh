#!/bin/bash
# EC2 "User data" script (Ubuntu 24.04). Paste into: Launch instance -> Advanced details -> User data.
# It installs Docker, clones the repo, writes .env and starts FastAPI + Redis + Celery.
# Progress log on the instance:  sudo tail -f /var/log/cloud-init-output.log
set -euxo pipefail

# ---------- EDIT THESE 3 LINES ----------
REPO_URL="https://github.com/abduIIahKhaIid/signature-ai-mlops-platform"   # public repo, or see docs/setup/deploy_ec2.md for private
SERVICE_DIR="signature_service"                               # folder inside the repo
LOGFIRE_TOKEN=""   # optional; NEVER commit a real token: set it in ~/app/signature_service/.env on the server
# ----------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git

# Docker Engine + compose plugin (official repository)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# 4 GB swap: the torch install / model load can spike memory on small instances
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Code
cd /home/ubuntu
[ -d app ] || git clone "$REPO_URL" app
cd "app/$SERVICE_DIR"

# .env: no AWS keys here, the instance IAM role gives S3 read access
cp .env.example .env
sed -i "s|^MODEL_ALIAS=.*|MODEL_ALIAS=latest|" .env
sed -i "s|^AWS_ACCESS_KEY_ID=.*|AWS_ACCESS_KEY_ID=|" .env
sed -i "s|^AWS_SECRET_ACCESS_KEY=.*|AWS_SECRET_ACCESS_KEY=|" .env
sed -i "s|^AWS_DEFAULT_REGION=.*|AWS_DEFAULT_REGION=ap-southeast-2|" .env
sed -i "s|^ENVIRONMENT=.*|ENVIRONMENT=ec2|" .env
sed -i "s|^LOGFIRE_TOKEN=.*|LOGFIRE_TOKEN=${LOGFIRE_TOKEN}|" .env
# Use all vCPUs: one Celery process per vCPU, one torch thread each
VCPUS=$(nproc)
sed -i "s|^WORKER_CONCURRENCY=.*|WORKER_CONCURRENCY=${VCPUS}|" .env
sed -i "s|^TORCH_THREADS=.*|TORCH_THREADS=1|" .env
chown -R ubuntu:ubuntu /home/ubuntu/app

docker compose up -d --build
echo "SIGNATURE SERVICE STARTED"
