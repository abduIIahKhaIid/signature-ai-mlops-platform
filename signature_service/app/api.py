"""FastAPI front door. It never runs the model: it stores the upload, enqueues a Celery job
and returns a job id (async) or waits a bounded time for the result (?wait=true).
"""
from __future__ import annotations

import time
from typing import Annotated

from celery.result import AsyncResult
from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from . import observability
from .celery_app import DETECT_TASK, MODEL_INFO_TASK, VERIFY_TASK, celery_app
from .config import settings
from .ratelimit import limit_jobs
from .storage import get_storage

observability.setup("api")
app = FastAPI(
    title="SignatureAI API",
    version="1.0.0",
    description="Signature detection (RT-DETRv2) and signature similarity, served through a Redis/Celery queue.",
)
observability.instrument_fastapi(app)
# compress JSON and the web app files (the JS bundle shrinks ~3x); images are uploaded, not sent back
app.add_middleware(GZipMiddleware, minimum_size=1000)
API_STARTED = time.time()

from . import web  # noqa: E402
from .pipeline_api import router as pipeline_router  # noqa: E402
from .webhooks import router as webhooks_router  # noqa: E402

app.include_router(webhooks_router)
app.include_router(pipeline_router)
web.mount(app)  # React app: / (detect), /verify, /pipeline

ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
                 "image/bmp": ".bmp", "image/tiff": ".tif"}


async def _store_upload(upload: UploadFile) -> str:
    suffix = ALLOWED_TYPES.get((upload.content_type or "").lower())
    if suffix is None:
        raise HTTPException(415, f"unsupported content type {upload.content_type!r}; send JPEG/PNG/WEBP/BMP/TIFF")
    data = await upload.read(settings.max_upload_bytes + 1)
    if not data:
        raise HTTPException(400, "empty file")
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, f"file larger than {settings.max_upload_bytes} bytes")
    return await run_in_threadpool(get_storage().put, data, suffix)


def _job_payload(result: AsyncResult) -> dict:
    state = result.state
    body: dict = {"job_id": result.id, "status": state}
    if state == "SUCCESS":
        body["result"] = result.result
    elif state == "RETRY":
        body["retry_reason"] = str(result.info)
    elif state == "FAILURE":
        error = result.result
        body["error"] = f"{type(error).__name__}: {error}" if isinstance(error, Exception) else str(error)
    return body


async def _respond(result: AsyncResult, wait: bool, timeout: float) -> JSONResponse:
    if wait:
        timeout = min(timeout, settings.sync_wait_max_seconds)
        try:
            await run_in_threadpool(result.get, timeout=timeout, propagate=False, disable_sync_subtasks=False)
        except Exception:  # celery TimeoutError: still running, the client can poll
            pass
    body = _job_payload(result)
    if body["status"] == "SUCCESS":
        code = 200
    elif body["status"] == "FAILURE":
        code = 422 if "InvalidImage" in body.get("error", "") else 500
    else:
        code = 202
        body["poll_url"] = f"/v1/jobs/{result.id}"
    return JSONResponse(body, status_code=code)


SimulateFailures = Annotated[int, Query(
    ge=0, le=10, description="Demo only (needs ALLOW_FAILURE_SIMULATION=true): fail N times before succeeding")]


def _check_simulation(simulate_failures: int) -> None:
    if simulate_failures and not settings.allow_failure_simulation:
        raise HTTPException(403, "failure simulation is disabled (ALLOW_FAILURE_SIMULATION=false)")


@app.post("/v1/detect", summary="Detect signatures in one document image", dependencies=[Depends(limit_jobs)])
async def detect(
    file: Annotated[UploadFile, File(description="Document image (JPEG/PNG/WEBP/BMP/TIFF)")],
    wait: Annotated[bool, Query(description="Wait for the result instead of only returning a job id")] = False,
    timeout: Annotated[float, Query(gt=0, le=120)] = 20,
    threshold: Annotated[float | None, Query(ge=0, le=1)] = None,
    simulate_failures: SimulateFailures = 0,
):
    _check_simulation(simulate_failures)
    key = await _store_upload(file)
    result = celery_app.send_task(DETECT_TASK, args=[key, threshold],
                                  kwargs={"enqueued_at": time.time(), "simulate_failures": simulate_failures})
    return await _respond(result, wait, timeout)


@app.post("/v1/verify", summary="Similarity score between a reference and a candidate signature",
          dependencies=[Depends(limit_jobs)])
async def verify(
    reference: Annotated[UploadFile, File(description="Known genuine signature or document")],
    candidate: Annotated[UploadFile, File(description="Signature or document to check")],
    crop: Annotated[bool, Query(description="Detect and crop the signature first")] = True,
    wait: bool = False,
    timeout: Annotated[float, Query(gt=0, le=120)] = 20,
    simulate_failures: SimulateFailures = 0,
):
    _check_simulation(simulate_failures)
    reference_key = await _store_upload(reference)
    candidate_key = await _store_upload(candidate)
    result = celery_app.send_task(VERIFY_TASK, args=[reference_key, candidate_key, crop],
                                  kwargs={"enqueued_at": time.time(), "simulate_failures": simulate_failures})
    return await _respond(result, wait, timeout)


@app.get("/v1/jobs/{job_id}", summary="Job status / result")
async def job(job_id: str):
    return await _respond(AsyncResult(job_id, app=celery_app), wait=False, timeout=0)


@app.get("/v1/model", summary="Model currently served by a worker")
async def model():
    result = celery_app.send_task(MODEL_INFO_TASK)
    return await _respond(result, wait=True, timeout=10)


@app.get("/health", summary="Liveness: the API process is up")
async def health():
    return {"status": "ok", "version": settings.app_version, "uptime_seconds": round(time.time() - API_STARTED, 1)}


@app.get("/ready", summary="Readiness: Redis reachable and at least one worker online")
async def ready():
    def check():
        with celery_app.connection_for_write() as conn:
            conn.ensure_connection(max_retries=1)
        replies = celery_app.control.inspect(timeout=1.0).ping() or {}
        return len(replies)

    try:
        workers = await run_in_threadpool(check)
    except Exception as exc:
        return JSONResponse({"status": "not_ready", "reason": f"broker unreachable: {exc}"}, status_code=503)
    if workers == 0:
        return JSONResponse({"status": "not_ready", "reason": "no worker online"}, status_code=503)
    return {"status": "ready", "workers": workers}
