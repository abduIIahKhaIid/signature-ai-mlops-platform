#!/bin/bash
# EC2 "User data" script (Ubuntu 24.04). Paste into: Launch instance -> Advanced details -> User data.
# It installs Docker + AWS CLI, clones the repo, securely fetches .env from
# AWS Secrets Manager, and starts FastAPI + Redis + Celery.
# Progress log on the instance:  sudo tail -f /var/log/cloud-init-output.log
set -euo pipefail

# ---------- EDIT THESE 2 LINES ----------
REPO_URL="https://github.com/abduIIahKhaIid/signature-ai-mlops-platform"   # public repo, or see docs/setup/deploy_ec2.md for private
SERVICE_DIR="signature_service"                               # folder inside the repo
# ----------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git unzip

# AWS CLI v2 is required by deploy/sync_secrets.sh. Install the official AWS
# package for this instance architecture; authentication comes from the EC2 role.
if ! command -v aws >/dev/null 2>&1; then
  case "$(dpkg --print-architecture)" in
    amd64) AWSCLI_ARCH="x86_64" ;;
    arm64) AWSCLI_ARCH="aarch64" ;;
    *) echo "unsupported architecture for AWS CLI: $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
  AWSCLI_TMP="$(mktemp -d)"
  trap 'rm -rf -- "${AWSCLI_TMP}"' EXIT
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWSCLI_ARCH}.zip" -o "${AWSCLI_TMP}/awscliv2.zip"
  unzip -q "${AWSCLI_TMP}/awscliv2.zip" -d "${AWSCLI_TMP}"
  "${AWSCLI_TMP}/aws/install" --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli
  rm -rf -- "${AWSCLI_TMP}"
  trap - EXIT
fi
aws --version

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
SHA="$(git rev-parse HEAD)"
chown -R ubuntu:ubuntu /home/ubuntu/app

# Use the same fail-closed path as CI/CD. It fetches and validates Secrets
# Manager before stopping anything, writes APP_VERSION, builds, starts and waits.
bash deploy/remote_deploy.sh "${SHA}"
echo "SIGNATURE SERVICE STARTED AT ${SHA}"
