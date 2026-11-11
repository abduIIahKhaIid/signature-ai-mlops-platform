"""ModelHolder start-up: a broken similarity model must not stop detection; hot reload repairs it later."""
from __future__ import annotations

import dataclasses
import types

import pytest

import app.inference as inference
import app.model_registry as registry
from app import tasks


class FakeDetector:
    def __init__(self, resolved):
        self.version, self.load_seconds = resolved.version, 0.1


@pytest.fixture()
def holder(monkeypatch):
    monkeypatch.setattr(inference, "SignatureDetector", FakeDetector)
    monkeypatch.setattr(registry, "resolve_current_model", lambda: types.SimpleNamespace(version="det-v1"))
    monkeypatch.setattr(tasks, "settings", dataclasses.replace(
        tasks.settings, enable_similarity=True, similarity_s3_alias="latest", model_s3_bucket="models",
        model_poll_seconds=300))
    monkeypatch.setattr(registry, "current_similarity_target", lambda client=None: {"version": "sim-v1", "sha256": "a" * 64})
    monkeypatch.setattr(registry, "current_target_version", lambda: "det-v1")   # detector alias unchanged
    h = tasks.ModelHolder()
    monkeypatch.setattr(tasks, "models", h)   # similarity_unavailable_reason() reads the module-level holder
    return h


def test_broken_similarity_alias_at_start_up_keeps_detection_working(holder, monkeypatch):
    def broken(alias=None):
        raise RuntimeError("SHA-256 mismatch for similarity weights: refusing to load")
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3", staticmethod(broken))

    holder.load()                                            # must not raise
    assert holder.detector.version == "det-v1" and holder.embedder is None
    assert "SHA-256 mismatch" in holder.last_similarity_reload_error
    assert "SHA-256 mismatch" in holder.last_reload_error   # shown by /v1/model and the dashboard
    reason = tasks.similarity_unavailable_reason()
    assert "not loaded" in reason and "SHA-256 mismatch" in reason and "Detection is not affected" in reason
    assert "every 300 s" in reason


def test_hot_reload_repairs_similarity_after_a_failed_start(holder, monkeypatch):
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3",
                        staticmethod(lambda alias=None: (_ for _ in ()).throw(RuntimeError("bad alias"))))
    holder.load()
    assert holder.embedder is None

    fixed = types.SimpleNamespace(version="sim-v2", threshold=0.9)
    monkeypatch.setattr(registry, "current_similarity_target", lambda client=None: {"version": "sim-v2", "sha256": "b" * 64})
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3", staticmethod(lambda alias=None: fixed))
    holder._reload_similarity_if_needed()                    # what the poll loop runs every MODEL_POLL_SECONDS
    assert holder.embedder is fixed


def test_good_start_up_has_no_error(holder, monkeypatch):
    good = types.SimpleNamespace(version="sim-v1", threshold=0.8)
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3", staticmethod(lambda alias=None: good))
    holder.load()
    assert holder.embedder is good and holder.last_similarity_reload_error is None


def test_similarity_switched_off(holder, monkeypatch):
    monkeypatch.setattr(tasks, "settings", dataclasses.replace(tasks.settings, enable_similarity=False))
    holder.load()
    assert holder.embedder is None and holder.last_similarity_reload_error is None
    assert tasks.similarity_unavailable_reason() == "similarity is disabled on this worker (ENABLE_SIMILARITY=false)"


def test_a_broken_release_is_not_downloaded_again_every_poll(holder, monkeypatch):
    calls = []

    def broken(alias=None):
        calls.append(alias["version"])
        raise RuntimeError("SHA-256 mismatch")
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3", staticmethod(broken))
    holder.load()                                   # start-up fails on sim-v1 ...
    holder.poll_once()                              # ... and the next polls do not download it again
    holder.poll_once()
    assert calls == ["sim-v1"]
    assert "SHA-256 mismatch" in holder.last_similarity_reload_error
    assert "not downloaded again before" in holder.last_similarity_reload_error
    assert holder.last_detector_reload_error is None

    monkeypatch.setattr(registry, "current_similarity_target", lambda client=None: {"version": "sim-v2", "sha256": "b" * 64})
    holder.poll_once()                              # the alias moved to another release: tried at once
    assert calls == ["sim-v1", "sim-v2"]

    clock = [tasks.time.time() + tasks.settings.failed_release_retry_seconds + 1]
    monkeypatch.setattr(tasks.time, "time", lambda: clock[0])
    holder.poll_once()                              # after FAILED_RELEASE_RETRY_SECONDS: tried again
    assert calls == ["sim-v1", "sim-v2", "sim-v2"]


def test_a_broken_detector_release_backs_off_too(holder, monkeypatch):
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3",
                        staticmethod(lambda alias=None: types.SimpleNamespace(version="sim-v1", threshold=0.8)))
    holder.load()
    fetches = []

    class BrokenRegistry:
        def __init__(self, *a):
            pass

        def fetch(self, version):
            fetches.append(version)
            raise RuntimeError(f"SHA-256 mismatch for {version}: refusing to load")
    monkeypatch.setattr(registry, "current_target_version", lambda: "det-v2")
    monkeypatch.setattr(registry, "S3ModelRegistry", BrokenRegistry)
    monkeypatch.setattr(tasks, "settings", dataclasses.replace(tasks.settings, model_source="s3", model_version=None))
    holder.poll_once()
    holder.poll_once()
    assert fetches == ["det-v2"] and holder.detector.version == "det-v1"   # old detector keeps serving
    assert "not downloaded again before" in holder.last_detector_reload_error
    assert holder.last_similarity_reload_error is None


def test_a_good_poll_clears_the_error(holder, monkeypatch):
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3",
                        staticmethod(lambda alias=None: (_ for _ in ()).throw(RuntimeError("bad"))))
    holder.load()
    good = types.SimpleNamespace(version="sim-v2", threshold=0.9)
    monkeypatch.setattr(registry, "current_similarity_target", lambda client=None: {"version": "sim-v2", "sha256": "b" * 64})
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3", staticmethod(lambda alias=None: good))
    holder.poll_once()
    assert holder.embedder is good and holder.last_similarity_reload_error is None and holder.last_reload_error is None


def test_unapproved_detector_alias_at_start_up_serves_the_last_approved_detector(holder, monkeypatch):
    from app.promotion import UnapprovedRelease

    def refused():
        raise UnapprovedRelease("alias 'production' -> v9 has no gate record")
    monkeypatch.setattr(registry, "resolve_current_model", refused)
    monkeypatch.setattr(registry, "last_served_detector", lambda: types.SimpleNamespace(version="det-v0"))
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3",
                        staticmethod(lambda alias=None: types.SimpleNamespace(version="sim-v1", threshold=0.8)))
    holder.load()
    assert holder.detector.version == "det-v0"
    assert "no gate record" in holder.last_detector_reload_error and "last approved detector det-v0" in holder.last_reload_error

    monkeypatch.setattr(registry, "last_served_detector", lambda: None)     # a fresh host has nothing to fall back to
    with pytest.raises(UnapprovedRelease):
        tasks.ModelHolder().load()


def test_approved_start_up_records_the_serving_detector(holder, monkeypatch, tmp_path):
    recorded = []
    monkeypatch.setattr(registry, "remember_serving_detector", recorded.append)
    monkeypatch.setattr(tasks, "settings", dataclasses.replace(tasks.settings, model_source="s3", model_version=None))
    monkeypatch.setattr(tasks.ModelHolder, "_load_similarity_from_s3",
                        staticmethod(lambda alias=None: types.SimpleNamespace(version="sim-v1", threshold=0.8)))
    holder.load()
    assert recorded == ["det-v1"]


def test_detector_display_name_follows_the_model_architecture():
    from app.inference import detector_display_name

    assert detector_display_name("rt_detr_v2") == "RT-DETRv2"
    assert detector_display_name("d_fine") == "D-FINE"
    assert detector_display_name("some_new_detr") == "SOME-NEW-DETR"
    assert detector_display_name(None) == "Detector"
