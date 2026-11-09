FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TORCH_HOME=/opt/torch
WORKDIR /srv

# CPU-only torch keeps the image ~1 GB instead of several GB of CUDA libraries.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
COPY requirements-worker.txt .
RUN pip install -r requirements-worker.txt

# Bake the ImageNet ResNet18 weights (similarity baseline) into the image so a cold start
# does not depend on download.pytorch.org. The DETECTION model is NOT baked in: it is
# pulled from S3 at start-up, verified by SHA-256, and cached in the /models volume.
RUN python -c "import torchvision; torchvision.models.resnet18(weights='DEFAULT')"

COPY app ./app
RUN useradd --uid 10001 --create-home appuser \
 && mkdir -p /data/uploads /models && chown -R appuser /data /models /opt/torch
USER appuser

CMD ["sh", "-c", "celery -A app.celery_app:celery_app worker --loglevel=INFO -Q ${INFERENCE_QUEUE:-inference} --concurrency=${WORKER_CONCURRENCY:-2} --prefetch-multiplier=1 -n worker@%h"]
