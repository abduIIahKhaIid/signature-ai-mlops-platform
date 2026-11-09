"""Hugging Face dataset webhook -> retraining.

RETRAIN_BACKEND=ec2 (default): the event is queued for the pipeline worker on this EC2 host, which checks the
    repo for a new (never trained) dataset ZIP and runs the training on Kaggle. Several webhooks within
    PIPELINE_DEBOUNCE_SECONDS (an upload often makes more than one commit) become one check.
RETRAIN_BACKEND=github: legacy path, fires `repository_dispatch` on GitHub Actions (.github/workflows/retrain.yml).

HF webhooks cannot send an Authorization header, so the shared secret arrives in `X-Webhook-Secret`.
"""
from __future__ import annotations

import hmac
import json
import logging
import urllib.error
import urllib.request

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


def _dispatch_to_github(hf_repo: str, hf_sha: str | None) -> int:
    body = json.dumps({"event_type": "hf-dataset-updated",
                       "client_payload": {"hf_repo": hf_repo, "hf_sha": hf_sha or "main",
                                          "mode": settings.retrain_mode}}).encode()
    request = urllib.request.Request(
        f"https://api.github.com/repos/{settings.github_repo}/dispatches", data=body, method="POST",
        headers={"Authorization": f"Bearer {settings.github_token}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "signatureai-webhook"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status  # 204 on success
    except urllib.error.HTTPError as exc:
        raise HTTPException(502, f"GitHub dispatch failed: HTTP {exc.code}") from exc


@router.post("/huggingface", status_code=202, summary="Hugging Face dataset update -> retraining")
async def huggingface_webhook(request: Request, x_webhook_secret: str | None = Header(default=None)):
    github = settings.retrain_backend == "github"
    if not settings.hf_webhook_secret or (github and not (settings.github_repo and settings.github_token)):
        raise HTTPException(503, "retraining webhook is not configured on this server")
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
        return {"accepted": False, "dispatched": False, "reason": reason}

    if repo_type != "dataset":
        return ignored("not a dataset repo")
    if settings.hf_dataset_repo and repo_name != settings.hf_dataset_repo:
        return ignored("different dataset repo")
    if not str(event.get("scope", "")).startswith("repo.content"):
        return ignored("not a content change (discussion, config, ...)")
    if event.get("action") not in {"update", "create"}:
        return ignored(f"action {event.get('action')!r}")

    if not github:
        queued = await run_in_threadpool(_enqueue_check, head_sha)
        log.info("HF webhook accepted for %s@%s (check %s)", repo_name, head_sha, "queued" if queued else "already queued")
        return {"accepted": True, "backend": "ec2", "hf_repo": repo_name, "hf_sha": head_sha,
                "check": "queued" if queued else "already queued (debounce)",
                "note": "the pipeline worker checks for a new, never-trained dataset ZIP; see /pipeline"}

    # legacy GitHub backend: one dispatch per commit and per cooldown window
    def claim() -> str | None:
        r = _redis()
        if head_sha and not r.set(f"retrain:sha:{head_sha}", 1, nx=True, ex=7 * 24 * 3600):
            return "this dataset commit was already dispatched"
        if not r.set("retrain:cooldown", head_sha or "unknown", nx=True, ex=settings.retrain_cooldown_seconds):
            return f"cooldown active ({settings.retrain_cooldown_seconds}s between retrains)"
        return None

    reason = await run_in_threadpool(claim)
    if reason:
        return ignored(reason)
    status = await run_in_threadpool(_dispatch_to_github, repo_name, head_sha)
    log.info("retraining dispatched to GitHub %s for %s@%s (HTTP %s)", settings.github_repo, repo_name, head_sha, status)
    return {"accepted": True, "dispatched": True, "backend": "github", "hf_repo": repo_name, "hf_sha": head_sha,
            "github_repo": settings.github_repo, "mode": settings.retrain_mode}
