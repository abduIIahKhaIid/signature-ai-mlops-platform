"""Where uploaded images live between the API and the workers.

Images are NOT sent through Redis: the API stores the bytes and puts only a small key on
the queue. "local" = a docker volume shared by api + worker (single host);
"s3" = an S3 prefix (needed when api and workers run on different machines).
"""
from __future__ import annotations

import uuid
from pathlib import Path

from .config import settings


class Storage:
    def put(self, data: bytes, suffix: str = ".img") -> str:
        raise NotImplementedError

    def get(self, key: str) -> bytes:
        raise NotImplementedError

    def delete(self, key: str) -> None:
        raise NotImplementedError


class LocalStorage(Storage):
    def __init__(self, root: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents:
            raise ValueError("invalid storage key")
        return path

    def put(self, data: bytes, suffix: str = ".img") -> str:
        key = f"{uuid.uuid4().hex}{suffix}"
        self._path(key).write_bytes(data)
        return key

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class S3Storage(Storage):
    def __init__(self, bucket: str, prefix: str):
        import boto3

        self.client = boto3.client("s3")  # credentials from IAM role / env, never hard-coded
        self.bucket = bucket
        self.prefix = prefix.strip("/")

    def put(self, data: bytes, suffix: str = ".img") -> str:
        key = f"{self.prefix}/{uuid.uuid4().hex}{suffix}"
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ServerSideEncryption="AES256")
        return key

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        if settings.storage_backend == "s3":
            if not settings.uploads_s3_bucket:
                raise RuntimeError("STORAGE_BACKEND=s3 requires UPLOADS_S3_BUCKET")
            _storage = S3Storage(settings.uploads_s3_bucket, settings.uploads_s3_prefix)
        else:
            _storage = LocalStorage(settings.local_storage_dir)
    return _storage
