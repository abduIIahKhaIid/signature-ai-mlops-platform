import zipfile

import boto3
import pytest
from moto import mock_aws

from app.model_registry import S3ModelRegistry, _safe_extract
from tests.helpers import publish_similarity_version, publish_version

BUCKET, PREFIX = "models", "signatureai/detection"


@pytest.fixture()
def s3():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


def test_alias_resolves_and_model_loads(s3, tmp_path):
    from transformers import AutoModelForObjectDetection

    publish_version(s3, BUCKET, PREFIX, "v1", tmp_path / "pub")
    registry = S3ModelRegistry(BUCKET, PREFIX, str(tmp_path / "cache"), client=s3)
    assert registry.resolve_version(alias="latest") == "v1"
    resolved = registry.fetch("v1")
    assert (resolved.path / "config.json").exists()
    assert AutoModelForObjectDetection.from_pretrained(resolved.path).config.id2label[0] == "signature"


def test_second_fetch_uses_cache(s3, tmp_path):
    publish_version(s3, BUCKET, PREFIX, "v1", tmp_path / "pub")
    registry = S3ModelRegistry(BUCKET, PREFIX, str(tmp_path / "cache"), client=s3)
    registry.fetch("v1")
    s3.delete_object(Bucket=BUCKET, Key=f"{PREFIX}/versions/v1/artifact.zip")  # would fail if re-downloaded
    assert (registry.fetch("v1").path / "config.json").exists()


def test_sha_mismatch_is_refused(s3, tmp_path):
    publish_version(s3, BUCKET, PREFIX, "bad", tmp_path / "pub", tamper=True)
    registry = S3ModelRegistry(BUCKET, PREFIX, str(tmp_path / "cache"), client=s3)
    with pytest.raises(RuntimeError, match="SHA-256 mismatch"):
        registry.fetch("bad")


def test_pinned_version_wins_over_alias(s3, tmp_path):
    publish_version(s3, BUCKET, PREFIX, "v1", tmp_path / "pub")
    registry = S3ModelRegistry(BUCKET, PREFIX, str(tmp_path / "cache"), client=s3)
    assert registry.resolve_version(alias="latest", version="v0-pinned") == "v0-pinned"


def test_bad_alias_rejected(s3, tmp_path):
    registry = S3ModelRegistry(BUCKET, PREFIX, str(tmp_path / "cache"), client=s3)
    with pytest.raises(ValueError):
        registry.resolve_version(alias="staging")


def test_zip_slip_rejected(tmp_path):
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("../../escape.txt", "x")
    with pytest.raises(ValueError, match="unsafe"):
        _safe_extract(archive, tmp_path / "out")


def test_similarity_weights_from_s3_alias(s3, tmp_path, monkeypatch):
    import dataclasses

    import app.model_registry as reg
    from app.inference import SignatureEmbedder

    publish_similarity_version(s3, BUCKET, "signatureai/similarity", "s1", tmp_path, threshold=0.71)
    monkeypatch.setattr(reg, "settings", dataclasses.replace(
        reg.settings, model_s3_bucket=BUCKET, similarity_s3_alias="latest", model_cache_dir=str(tmp_path / "cache")))
    assert reg.current_similarity_target(client=s3)["version"] == "s1"
    path, meta = reg.fetch_similarity_weights(client=s3)
    assert meta["recommended_threshold"] == 0.71 and path.exists()
    assert SignatureEmbedder(False, str(path)).name == "resnet18-finetuned"
    # tampered weights checksum -> refused before the working model can be replaced
    publish_similarity_version(s3, BUCKET, "signatureai/similarity", "s2", tmp_path,
                               threshold=0.72, tamper=True)
    with pytest.raises(RuntimeError, match="SHA-256"):
        reg.fetch_similarity_weights(client=s3)


def test_similarity_alias_rejects_unsafe_metadata(s3, tmp_path, monkeypatch):
    import dataclasses
    import json

    import app.model_registry as reg

    monkeypatch.setattr(reg, "settings", dataclasses.replace(
        reg.settings, model_s3_bucket=BUCKET, similarity_s3_alias="latest", model_cache_dir=str(tmp_path / "cache")))
    base = {"version": "s1", "weights_key": "signatureai/similarity/versions/s1/siamese_resnet18.pt",
            "sha256": "a" * 64, "recommended_threshold": 0.7}
    for changed, message in [
        ({"version": "../s1"}, "invalid version"),
        ({"weights_key": "somewhere/else.pt"}, "weights_key"),
        ({"sha256": "short"}, "SHA-256"),
        ({"recommended_threshold": 1.5}, "between 0 and 1"),
    ]:
        alias = {**base, **changed}
        s3.put_object(Bucket=BUCKET, Key="signatureai/similarity/aliases/latest.json", Body=json.dumps(alias))
        with pytest.raises(RuntimeError, match=message):
            reg.current_similarity_target(client=s3)
