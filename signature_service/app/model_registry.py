"""Pull the detection model from the S3 registry written by the training notebook.

Registry layout (created by the notebook):
    <prefix>/aliases/latest.json | production.json   -> {"version": ..., ...}
    <prefix>/versions/<version>/manifest.json        -> {"artifact_sha256": ..., "model_subdirectory": "best_model"}
    <prefix>/versions/<version>/artifact.zip         -> best_model/ (+ reports/)

Weights never live in git or in the docker image: the worker downloads them at start-up,
verifies SHA-256 and caches them in MODEL_CACHE_DIR (a volume, so restarts are fast).
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import math
import os
import re
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .config import settings

log = logging.getLogger("signature.registry")


@dataclass(frozen=True)
class ResolvedModel:
    version: str
    path: Path
    manifest: dict


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


@contextmanager
def _file_lock(path: Path):
    """Serialize downloads when several worker processes start at the same time."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _safe_extract(archive: Path, dest: Path) -> None:
    base = dest.resolve()
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            target = (dest / info.filename).resolve()
            if base != target and base not in target.parents:
                raise ValueError(f"unsafe archive entry: {info.filename}")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("symlinks are not allowed in model archives")
        z.extractall(dest)


class S3ModelRegistry:
    def __init__(self, bucket: str, prefix: str, cache_dir: str, client=None):
        if client is None:
            import boto3

            client = boto3.client("s3")
        self.s3 = client
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.cache_dir = Path(cache_dir)

    def _json(self, key: str) -> dict:
        return json.loads(self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read())

    def resolve_version(self, alias: str | None = None, version: str | None = None) -> str:
        if version:
            return version
        if alias not in {"latest", "production"}:
            raise ValueError("MODEL_ALIAS must be 'latest' or 'production' (or set MODEL_VERSION)")
        return self._json(f"{self.prefix}/aliases/{alias}.json")["version"]

    def fetch(self, version: str) -> ResolvedModel:
        manifest = self._json(f"{self.prefix}/versions/{version}/manifest.json")
        if manifest.get("version") != version:
            raise RuntimeError("manifest version mismatch")
        expected_sha = manifest["artifact_sha256"]
        subdir = manifest.get("model_subdirectory", "best_model")

        version_dir = self.cache_dir / version
        model_path = version_dir / "unpacked" / subdir
        marker = version_dir / ".verified"
        with _file_lock(self.cache_dir / f".{version}.lock"):
            if marker.exists() and marker.read_text() == expected_sha and (model_path / "config.json").exists():
                log.info("model %s found in cache", version)
                return ResolvedModel(version, model_path, manifest)

            version_dir.mkdir(parents=True, exist_ok=True)
            archive = version_dir / "artifact.zip"
            tmp = version_dir / "artifact.zip.part"
            key = f"{self.prefix}/versions/{version}/artifact.zip"
            log.info("downloading s3://%s/%s", self.bucket, key)
            self.s3.download_file(self.bucket, key, str(tmp))
            actual_sha = _sha256(tmp)
            if actual_sha != expected_sha:
                tmp.unlink(missing_ok=True)
                raise RuntimeError(f"SHA-256 mismatch for {version}: refusing to load")
            os.replace(tmp, archive)
            _safe_extract(archive, version_dir / "unpacked")
            archive.unlink()  # keep only the unpacked model to save disk
            if not (model_path / "config.json").exists():
                raise RuntimeError(f"artifact for {version} has no {subdir}/config.json")
            marker.write_text(expected_sha)
            return ResolvedModel(version, model_path, manifest)


def resolve_current_model() -> ResolvedModel:
    """Model selected by the environment: local folder (dev) or S3 alias / pinned version."""
    if settings.model_source == "local":
        if not settings.local_model_dir:
            raise RuntimeError("MODEL_SOURCE=local requires LOCAL_MODEL_DIR")
        path = Path(settings.local_model_dir)
        meta_file = path / "version_metadata.json"
        meta = json.loads(meta_file.read_text()) if meta_file.exists() else {}
        return ResolvedModel(meta.get("version", f"local:{path.name}"), path, meta)

    if not settings.model_s3_bucket:
        raise RuntimeError("MODEL_SOURCE=s3 requires MODEL_S3_BUCKET")
    registry = S3ModelRegistry(settings.model_s3_bucket, settings.model_s3_prefix, settings.model_cache_dir)
    version = registry.resolve_version(settings.model_alias, settings.model_version)
    return registry.fetch(version)


def current_target_version() -> str | None:
    """Cheap check (one small S3 GET) used by hot reload. None when not applicable."""
    if settings.model_source != "s3" or settings.model_version or not settings.model_s3_bucket:
        return None
    registry = S3ModelRegistry(settings.model_s3_bucket, settings.model_s3_prefix, settings.model_cache_dir)
    return registry.resolve_version(settings.model_alias)


def _validate_similarity_alias(alias: dict, prefix: str) -> dict:
    """Reject malformed or unsafe aliases before they can influence a worker download/hot swap."""
    if not isinstance(alias, dict):
        raise RuntimeError("similarity alias must be a JSON object")
    version = alias.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", version):
        raise RuntimeError("similarity alias has an invalid version")
    expected_key = f"{prefix}/versions/{version}/siamese_resnet18.pt"
    if alias.get("weights_key") != expected_key:
        raise RuntimeError("similarity alias weights_key does not match its version")
    sha = alias.get("sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", sha):
        raise RuntimeError("similarity alias has an invalid SHA-256")
    threshold = alias.get("recommended_threshold")
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
        raise RuntimeError("similarity alias has no numeric recommended_threshold")
    if not math.isfinite(float(threshold)) or not 0.0 <= float(threshold) <= 1.0:
        raise RuntimeError("similarity alias recommended_threshold must be between 0 and 1")
    return alias


def current_similarity_target(client=None) -> dict | None:
    """Return the validated S3 alias followed by similarity workers, or None when disabled."""
    if not settings.enable_similarity or not settings.similarity_s3_alias:
        return None
    if settings.similarity_s3_alias not in {"latest", "production"}:
        raise ValueError("SIMILARITY_S3_ALIAS must be 'latest' or 'production'")
    if not settings.model_s3_bucket:
        raise RuntimeError("SIMILARITY_S3_ALIAS requires MODEL_S3_BUCKET")
    if client is None:
        import boto3

        client = boto3.client("s3")
    prefix = settings.similarity_s3_prefix.strip("/")
    alias = json.loads(client.get_object(Bucket=settings.model_s3_bucket,
                                         Key=f"{prefix}/aliases/{settings.similarity_s3_alias}.json")["Body"].read())
    return _validate_similarity_alias(alias, prefix)


def fetch_similarity_weights(client=None, alias: dict | None = None) -> tuple[Path, dict]:
    """Fetch one validated Siamese alias version, SHA-256 verify it, and reuse its versioned cache."""
    if client is None:
        import boto3

        client = boto3.client("s3")
    prefix = settings.similarity_s3_prefix.strip("/")
    alias = _validate_similarity_alias(alias, prefix) if alias is not None else current_similarity_target(client)
    if alias is None:
        raise RuntimeError("SIMILARITY_S3_ALIAS is not configured")
    target = Path(settings.model_cache_dir) / "similarity" / alias["version"] / "siamese_resnet18.pt"
    with _file_lock(Path(settings.model_cache_dir) / f".similarity-{alias['version']}.lock"):
        if not (target.exists() and _sha256(target) == alias["sha256"]):
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_suffix(".part")
            client.download_file(settings.model_s3_bucket, alias["weights_key"], str(tmp))
            if _sha256(tmp) != alias["sha256"]:
                tmp.unlink(missing_ok=True)
                raise RuntimeError("similarity weights SHA-256 mismatch: refusing to load")
            os.replace(tmp, target)
    return target, alias
