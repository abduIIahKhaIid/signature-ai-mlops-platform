"""Candidate (latest) vs production: only gated or admin-approved releases reach the workers."""
from __future__ import annotations

import dataclasses
import json

import boto3
import fakeredis
import pytest
from moto import mock_aws

import app.model_registry as reg
from app import retrain as R
from app.config import settings
from app.promotion import UnapprovedRelease, gate_problem
from tests.helpers import publish_similarity_version, publish_version

BUCKET, DET, SIM = "models", "signatureai/detection", "signatureai/similarity"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        cfg = dataclasses.replace(settings, model_s3_bucket=BUCKET, model_s3_prefix=DET, similarity_s3_prefix=SIM,
                                  model_alias="production", similarity_s3_alias="production",
                                  model_cache_dir=str(tmp_path / "cache"), model_poll_seconds=300)
        monkeypatch.setattr(reg, "settings", cfg)
        yield s3, cfg, R.PipelineStore(fakeredis.FakeRedis()), tmp_path


def put(s3, key, body):
    s3.put_object(Bucket=BUCKET, Key=key, Body=json.dumps(body))


def get(s3, key):
    return json.loads(s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())


# ---------------------------------------------------------------- the rule itself
@pytest.mark.parametrize("alias,name,ok", [
    ({"version": "v1"}, "latest", True),                                                       # candidates: no record needed
    ({"version": "v1"}, "production", False),                                                  # notebook wrote production by mistake
    ({"version": "v1", "gate": {"version": "v1", "passed": True}}, "production", True),
    ({"version": "v2", "gate": {"version": "v1", "passed": True}}, "production", False),       # record copied from another version
    ({"version": "v1", "gate": {"version": "v1", "passed": False, "reasons": ["mAP 0.4 < 0.75"]}}, "production", False),
    ({"version": "v1", "gate": {"version": "v1", "passed": False, "override": True, "approved_by": "admin", "reason": "hotfix"}},
     "production", True),
    ({"version": "v1", "gate": {"version": "v1", "override": True, "approved_by": "", "reason": "x"}}, "production", False),
])
def test_gate_rule(alias, name, ok):
    assert (gate_problem(alias, name) is None) is ok


# ---------------------------------------------------------------- workers refuse unapproved production aliases
def test_detector_production_alias_without_gate_record_is_refused(env):
    s3, cfg, _, tmp = env
    publish_version(s3, BUCKET, DET, "v1", tmp / "pub", alias="production")   # helper writes no gate record
    registry = reg.S3ModelRegistry(BUCKET, DET, cfg.model_cache_dir, client=s3)
    with pytest.raises(UnapprovedRelease, match="no gate record"):
        registry.resolve_version("production")
    publish_version(s3, BUCKET, DET, "v1", tmp / "pub", alias="latest")
    assert registry.resolve_version("latest") == "v1"                          # development may follow candidates


def test_similarity_production_alias_without_gate_record_is_refused(env):
    s3, cfg, _, tmp = env
    publish_similarity_version(s3, BUCKET, SIM, "s1", tmp / "pub", alias="production")
    with pytest.raises(UnapprovedRelease, match="no gate record"):
        reg.current_similarity_target(client=s3)


# ---------------------------------------------------------------- dashboard Promote / Roll back
def test_promote_a_detection_candidate_that_passed_its_gate(env):
    s3, cfg, store, tmp = env
    publish_version(s3, BUCKET, DET, "v1", tmp / "pub", alias="latest")
    put(s3, f"{DET}/pipeline_runs/v1.json", {"status": "approved_not_deployed", "test_map50": 0.83,
                                             "gate": {"passed": True, "baseline_test_map50": 0.80}})
    out = R.promote(store, s3, cfg, "detection", None, None, "dashboard (1.2.3.4)")
    assert out["to"] == "v1" and out["override"] is False
    alias = get(s3, f"{DET}/aliases/production.json")
    assert alias["gate"]["passed"] is True and alias["gate"]["metrics"]["test_map50"] == 0.83
    registry = reg.S3ModelRegistry(BUCKET, DET, cfg.model_cache_dir, client=s3)
    assert registry.resolve_version("production") == "v1"                     # the workers accept it
    assert store.audit_log()[0]["action"] == "promote"


def test_promoting_an_ungated_candidate_needs_a_reason(env):
    s3, cfg, store, tmp = env
    publish_version(s3, BUCKET, DET, "v2", tmp / "pub", alias="latest")      # e.g. a Colab notebook run: no gate
    with pytest.raises(R.ActionError, match="Give a reason"):
        R.promote(store, s3, cfg, "detection", None, "", "dashboard")
    out = R.promote(store, s3, cfg, "detection", None, "checked by hand on 50 real documents", "dashboard")
    assert out["override"] is True
    gate = get(s3, f"{DET}/aliases/production.json")["gate"]
    assert gate["override"] is True and gate["reason"] == "checked by hand on 50 real documents"
    with pytest.raises(R.ActionError, match="already"):
        R.promote(store, s3, cfg, "detection", "v2", "again", "dashboard")


def test_promote_refuses_versions_that_do_not_exist(env):
    s3, cfg, store, _ = env
    with pytest.raises(R.ActionError, match="no detection candidate"):
        R.promote(store, s3, cfg, "detection", None, "x", "dashboard")
    with pytest.raises(R.ActionError, match="no manifest"):
        R.promote(store, s3, cfg, "detection", "v9", "x", "dashboard")
    with pytest.raises(R.ActionError, match="invalid version"):
        R.promote(store, s3, cfg, "detection", "../v1", "x", "dashboard")


def test_promote_a_similarity_candidate_from_notebook_03(env):
    s3, cfg, store, tmp = env
    publish_similarity_version(s3, BUCKET, SIM, "s1", tmp / "pub", alias="latest", threshold=0.71)
    alias = get(s3, f"{SIM}/aliases/latest.json")
    put(s3, f"{SIM}/versions/s1/manifest.json", {"version": "s1", "weights_key": alias["weights_key"],
                                                "weights_sha256": alias["sha256"], "recommended_threshold": 0.71,
                                                "test_auc": 0.97, "test_eer": 0.06})
    put(s3, f"{SIM}/versions/s1/gate.json", {"passed": True, "checked_at": "2026-11-12T00:00:00Z",
                                            "metrics": {"test_auc": 0.97, "test_eer": 0.06}})
    R.promote(store, s3, cfg, "similarity", None, None, "dashboard")
    served = reg.current_similarity_target(client=s3)                         # workers accept it
    assert served["version"] == "s1" and served["recommended_threshold"] == 0.71 and served["gate"]["passed"]


def test_rollback_writes_an_approved_record(env):
    s3, cfg, store, tmp = env
    publish_version(s3, BUCKET, DET, "v-old", tmp / "pub", alias="latest")
    put(s3, f"{DET}/aliases/production.json", {"version": "v-new", "previous_version": "v-old",
                                                "gate": {"version": "v-new", "passed": True}})
    R.rollback(store, s3, cfg, "dashboard (1.2.3.4)")
    registry = reg.S3ModelRegistry(BUCKET, DET, cfg.model_cache_dir, client=s3)
    assert registry.resolve_version("production") == "v-old"                  # the rolled-back alias is accepted


def test_serving_summary_has_candidate_and_production(env):
    s3, cfg, store, _ = env
    put(s3, f"{DET}/aliases/latest.json", {"version": "v2", "stage": "latest_completed_candidate"})
    put(s3, f"{DET}/aliases/production.json", {"version": "v1", "gate": {"version": "v1", "passed": True, "checked_by": "gate"}})
    summary = R.alias_summary(get(s3, f"{DET}/aliases/production.json"))
    assert summary["version"] == "v1" and summary["gate"]["passed"] and "sha256" not in json.dumps(summary)
