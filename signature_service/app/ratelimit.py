"""Per-IP rate limit for the endpoints that create model jobs (/v1/detect, /v1/verify).

Fixed one-minute window counted in Redis, so all API processes share one count. If Redis is down the
request is let through (the job would fail at the queue anyway and the client gets that error instead).
"""
from __future__ import annotations

import hmac
import logging
import time

from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from .config import settings

log = logging.getLogger("signature.ratelimit")
_client = None


def _redis():
    global _client
    if _client is None:
        import redis

        _client = redis.Redis.from_url(settings.broker_url, socket_timeout=1, socket_connect_timeout=1)
    return _client


def _count(key: str) -> int:
    pipe = _redis().pipeline()
    pipe.incr(key)
    pipe.expire(key, 120)
    return int(pipe.execute()[0])


def _is_admin(request: Request) -> bool:
    token = request.headers.get("x-admin-token")
    return bool(token and settings.pipeline_admin_token and hmac.compare_digest(token, settings.pipeline_admin_token))


async def limit_jobs(request: Request) -> None:
    limit = settings.rate_limit_per_minute
    if limit <= 0 or _is_admin(request):
        return
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    key = f"ratelimit:jobs:{ip}:{int(now // 60)}"
    try:
        used = await run_in_threadpool(_count, key)
    except Exception as exc:  # fail open
        log.warning("rate limit check skipped (Redis unavailable: %s)", exc)
        return
    if used > limit:
        retry_after = 60 - int(now) % 60
        log.info("rate limit hit for %s (%d requests this minute, limit %d)", ip, used, limit)
        raise HTTPException(
            429,
            f"too many requests: at most {limit} detect/verify jobs per minute per client; try again in {retry_after} s",
            headers={"Retry-After": str(retry_after), "X-RateLimit-Limit": str(limit)},
        )
