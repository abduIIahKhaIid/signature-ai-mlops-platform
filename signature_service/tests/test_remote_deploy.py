"""deploy/remote_deploy.sh: ECR pull path, automatic rollback, and the "nothing touched" failure paths.

docker, curl, aws, git and sudo are replaced by small stub scripts on PATH, so the test runs anywhere bash runs.
The fake API reports APP_VERSION from .env as its version and is "not ready" for commits listed in stub/bad.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "remote_deploy.sh"
ECR = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/signatureai"
OLD, NEW = "a" * 40, "b" * 40

STUBS = {
    "docker": r"""#!/bin/bash
echo "docker $*" >> "$STUB/docker.log"
case "$*" in
  "compose pull"*)
    [[ -f "$STUB/pull_fails" ]] && exit 1
    for s in api worker pipeline; do echo "$ECR_IMAGE:$s-$IMAGE_TAG" >> "$STUB/images"; done ;;
  "compose build "*)
    tag="$(sed -n 's/^IMAGE_TAG=//p' .env)"; img="$(sed -n 's/^ECR_IMAGE=//p' .env)"
    echo "${img:-signatureai}:$4-${tag:-local}" >> "$STUB/images" ;;
  "image inspect "*) grep -qx "$3" "$STUB/images" 2>/dev/null ;;
  "compose ps --status running --services") echo pipeline ;;
  "images "*) cat "$STUB/images" 2>/dev/null ;;
  "rmi "*) grep -vx "$2" "$STUB/images" > "$STUB/images.tmp"; mv "$STUB/images.tmp" "$STUB/images" ;;
  "login "*) cat >/dev/null ;;
esac
exit 0
""",
    "curl": r"""#!/bin/bash
url="${*: -1}"
version="$(sed -n 's/^APP_VERSION=//p' "$SVC/.env" 2>/dev/null)"
[[ -f "$STUB/running" ]] || exit 7                      # nothing started yet in this test
case "$url" in
  */ready) grep -qx "$version" "$STUB/bad" 2>/dev/null && exit 22; exit 0 ;;
  */health) [[ -n "$version" ]] || exit 22; echo "{\"status\":\"ok\",\"version\":\"$version\"}" ;;
esac
""",
    "aws": "#!/bin/bash\necho \"aws $*\" >> \"$STUB/aws.log\"\necho token\n",
    "git": "#!/bin/bash\necho \"git $*\" >> \"$STUB/git.log\"\nexit 0\n",
    "sudo": "#!/bin/bash\n[[ \"$1\" == -u ]] && shift 2\nexec \"$@\"\n",
}


@pytest.fixture()
def env(tmp_path):
    if shutil.which("bash") is None:
        pytest.skip("bash not available")
    svc = tmp_path / "app" / "signature_service"
    (svc / "deploy").mkdir(parents=True)
    shutil.copy(SCRIPT, svc / "deploy" / "remote_deploy.sh")
    (svc / "deploy" / "sync_secrets.sh").write_text("#!/bin/bash\n[[ -f \"$STUB/sync_fails\" ]] && exit 1\nexit 0\n")
    (svc / "docker-compose.yml").write_text("services:\n  api:\n    image: ${ECR_IMAGE:-signatureai}:api-${IMAGE_TAG:-local}\n")
    (svc / ".env").write_text("LOG_LEVEL=INFO\n")
    stub = tmp_path / "stub"
    (stub / "bin").mkdir(parents=True)
    for name, body in STUBS.items():
        p = stub / "bin" / name
        p.write_text(body)
        p.chmod(0o755)
    (stub / "running").touch()
    run_env = {**os.environ, "PATH": f"{stub / 'bin'}:{os.environ['PATH']}", "STUB": str(stub), "SVC": str(svc),
               "READY_ATTEMPTS": "2", "READY_SLEEP": "0"}
    return svc, stub, run_env


def deploy(svc: Path, run_env: dict, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(svc / "deploy" / "remote_deploy.sh"), *args], env=run_env,
                          capture_output=True, text=True, timeout=120)


def env_value(svc: Path, key: str) -> str | None:
    for line in (svc / ".env").read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return None


def test_ecr_deploy_pulls_and_records_the_release(env):
    svc, stub, run_env = env
    (svc / ".deployed_sha").write_text(OLD)
    r = deploy(svc, run_env, NEW, ECR)
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"DEPLOY_OK {NEW}" in r.stdout
    assert (svc / ".deployed_sha").read_text().strip() == NEW
    assert env_value(svc, "APP_VERSION") == NEW and env_value(svc, "IMAGE_TAG") == NEW
    assert env_value(svc, "ECR_IMAGE") == ECR
    docker = (stub / "docker.log").read_text()
    assert "compose pull" in docker and "compose build" not in docker   # built once in CI, only pulled here
    assert "ecr get-login-password --region ap-southeast-2" in (stub / "aws.log").read_text()


def test_unhealthy_release_is_rolled_back_to_the_last_good_commit(env):
    svc, stub, run_env = env
    (svc / ".deployed_sha").write_text(OLD)
    (svc / ".env").write_text(f"APP_VERSION={OLD}\nECR_IMAGE={ECR}\nIMAGE_TAG={OLD}\n")
    (stub / "images").write_text("".join(f"{ECR}:{s}-{OLD}\n" for s in ("api", "worker", "pipeline")))
    (stub / "bad").write_text(NEW + "\n")                       # the new commit never becomes ready
    r = deploy(svc, run_env, NEW, ECR)
    assert r.returncode == 1, r.stdout + r.stderr                # CI is red ...
    assert f"ROLLED_BACK {NEW} -> {OLD}" in r.stdout             # ... but the old version serves again
    assert env_value(svc, "APP_VERSION") == OLD and env_value(svc, "IMAGE_TAG") == OLD
    assert (svc / ".deployed_sha").read_text().strip() == OLD
    assert f"reset --hard {OLD}" in (stub / "git.log").read_text()
    assert "previous images are still on this instance" in r.stdout


def test_failed_pull_changes_nothing(env):
    svc, stub, run_env = env
    (svc / ".deployed_sha").write_text(OLD)
    (svc / ".env").write_text(f"APP_VERSION={OLD}\n")
    (stub / "pull_fails").touch()
    r = deploy(svc, run_env, NEW, ECR)
    assert r.returncode == 1
    assert "nothing was changed" in r.stdout
    assert "compose up" not in (stub / "docker.log").read_text()
    assert (svc / ".deployed_sha").read_text().strip() == OLD


def test_failed_secret_sync_stops_before_touching_containers(env):
    svc, stub, run_env = env
    (stub / "sync_fails").touch()
    r = deploy(svc, run_env, NEW, ECR)
    assert r.returncode == 1
    assert not (stub / "docker.log").exists() or "compose" not in (stub / "docker.log").read_text()


def test_without_ecr_it_builds_on_the_instance(env):
    svc, stub, run_env = env
    r = deploy(svc, run_env, NEW)
    assert r.returncode == 0, r.stdout + r.stderr
    docker = (stub / "docker.log").read_text()
    assert "compose build api" in docker and "compose pull" not in docker
    assert env_value(svc, "ECR_IMAGE") == "signatureai"


def test_no_known_good_release_means_no_rollback(env):
    svc, stub, run_env = env
    (stub / "bad").write_text(NEW + "\n")
    r = deploy(svc, run_env, NEW, ECR)
    assert r.returncode == 2
    assert "cannot roll back" in r.stdout
