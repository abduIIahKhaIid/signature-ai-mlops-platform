# Retraining orchestrator (Celery queue "pipeline", concurrency 1, embedded beat).
# Build context = repository root (it needs pipeline/kaggle_job.py + pipeline/train_pipeline.ipynb);
# the root .dockerignore keeps the context to just those files and the service code.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    WORKER_ROLE=pipeline PIPELINE_DIR=/srv/pipeline PIPELINE_WORK_DIR=/data/pipeline KAGGLE_CONFIG_DIR=/data/pipeline/.kaggle
WORKDIR /srv

COPY signature_service/requirements-pipeline.txt .
RUN pip install -r requirements-pipeline.txt

COPY signature_service/app ./app
COPY pipeline/kaggle_job.py pipeline/train_pipeline.ipynb ./pipeline/
RUN useradd --uid 10001 --create-home appuser && mkdir -p /data/pipeline/.kaggle && chown -R appuser /data
USER appuser

# -B: the beat scheduler (pipeline.tick every PIPELINE_TICK_SECONDS) runs inside this single worker.
CMD ["sh", "-c", "celery -A app.celery_app:celery_app worker -B -s /data/pipeline/celerybeat-schedule --loglevel=INFO -Q ${PIPELINE_QUEUE:-pipeline} --concurrency=1 --prefetch-multiplier=1 -n pipeline@%h"]
