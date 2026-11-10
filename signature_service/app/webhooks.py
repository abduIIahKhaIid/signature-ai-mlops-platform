"""Hugging Face dataset webhook -> retraining on EC2 + Kaggle.

The event is queued for the pipeline worker on this EC2 host (Celery queue "pipeline"), which checks the HF repo
for a new (never trained) dataset ZIP and runs the training on a Kaggle T4. Several webhooks within
PIPELINE_DEBOUNCE_SECONDS (an upload often makes more than one commit) become one check.
GitHub Actions is NOT involved in retraining: it only tests and deploys the code (.github/workflows/ci-cd.yml).

HF webhooks cannot send an Authorization header, so the shared secret arrives in `X-Webhook-Secret`.
"""
from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from .config import settings

log = logging.getLogger("signature.webhooks")
router = APIRouter(prefix="/webhooks", tags=["retraining pipeline"])


def _redis():
    import redis

    return redis.Redis.from_url(settings.broker_url)


def _enqueue_check(hf_sha: str | None) -> bool:
    """Queue one dataset check on the pipeline worker; False if one is already queued (debounce window)."""
    from .celery_app import PIPELINE_CHECK_TASK, celery_app
    from .retrain import PipelineStore

    store = PipelineStore(_redis())
    store.decide("webhook", f"Hugging Face webhook: dataset repo changed (commit {(hf_sha or '?')[:8]})",
                 source="webhook", hf_sha=hf_sha)
    if not store.claim_webhook_window(settings.pipeline_debounce_seconds):
        return False
    celery_app.send_task(PIPELINE_CHECK_TASK, kwargs={"source": "webhook", "hf_sha": hf_sha},
                         queue=settings.pipeline_queue, countdown=settings.pipeline_debounce_seconds)
    return True


@router.post("/huggingface", status_code=202, summary="Hugging Face dataset update -> retraining (EC2 + Kaggle)")
async def huggingface_webhook(request: Request, x_webhook_secret: str | None = Header(default=None)):
    if not settings.hf_webhook_secret:
        raise HTTPException(503, "retraining webhook is not configured on this server (HF_WEBHOOK_SECRET)")
    if not x_webhook_secret or not hmac.compare_digest(x_webhook_secret, settings.hf_webhook_secret):
        raise HTTPException(401, "invalid webhook secret")

    payload = await request.json()
    event = payload.get("event") or {}
    repo = payload.get("repo") or {}
    repo_name, repo_type = repo.get("name"), repo.get("type")
    head_sha = repo.get("headSha")
    if not head_sha:
        for ref in payload.get("updatedRefs") or []:
            if ref.get("ref") in {"refs/heads/main", "main"}:
                head_sha = ref.get("newSha")

    def ignored(reason: str) -> dict:
        log.info("HF webhook ignored: %s (repo=%s scope=%s action=%s)", reason, repo_name,
                 event.get("scope"), event.get("action"))
        return {"accepted": False, "reason": reason}

    if repo_type != "dataset":
        return ignored("not a dataset repo")
    if settings.hf_dataset_repo and repo_name != settings.hf_dataset_repo:
        return ignored("different dataset repo")
    if not str(event.get("scope", "")).startswith("repo.content"):
        return ignored("not a content change (discussion, config, ...)")
    if event.get("action") not in {"update", "create"}:
        return ignored(f"action {event.get('action')!r}")

    queued = await run_in_threadpool(_enqueue_check, head_sha)
    log.info("HF webhook accepted for %s@%s (check %s)", repo_name, head_sha, "queued" if queued else "already queued")
    return {"accepted": True, "backend": "ec2", "hf_repo": repo_name, "hf_sha": head_sha,
            "check": "queued" if queued else "already queued (debounce)",
            "note": "the pipeline worker checks for a new, never-trained dataset ZIP; see /pipeline"}
