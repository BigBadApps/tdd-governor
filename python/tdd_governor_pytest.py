"""tdd-governor pytest plugin: appends one ledger record per pytest session.

Enable it in a client's root conftest.py (guarded, so CI without the governor still works):

    try:
        import tdd_governor_pytest  # noqa: F401
        pytest_plugins = ["tdd_governor_pytest"]
    except ImportError:
        pass
"""
from __future__ import annotations

import json
import os
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest


def classify(typename: str | None, message: str) -> str:
    # Mirrors src/classify.ts: structured exception type only, never scanned output.
    if typename == "AssertionError":
        return "assertion"
    if typename == "Failed":
        return "timeout" if message.startswith("Timeout") else "unknown"
    return "runtime_error" if typename else "unknown"


def _first_line(text: str | None) -> str:
    return (text or "").strip().split("\n")[0][:300]


def _git(root: Path, *args: str) -> str | None:
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


class _Recorder:
    def __init__(self, rootpath: Path) -> None:
        self.root = rootpath
        self.tests: dict[str, dict] = {}
        self.collection_errors: list[dict] = []

    def _rel(self, path: Path) -> str:
        return os.path.relpath(path, self.root).replace(os.sep, "/")

    def pytest_collectreport(self, report):
        if report.failed:
            lines = [l for l in str(report.longrepr).splitlines() if l.strip()]
            path = getattr(report, "path", None) or Path(report.nodeid.split("::")[0] or ".")
            self.collection_errors.append({"file": self._rel(Path(path)), "message": _first_line(lines[-1] if lines else "")})

    @pytest.hookimpl(hookwrapper=True)
    def pytest_runtest_makereport(self, item, call):
        outcome = yield
        rep = outcome.get_result()
        if rep.when == "teardown" or (rep.when == "setup" and rep.passed):
            return
        file = self._rel(item.path)
        domain = item.location[2]
        entry = {"id": f"{file} > {domain.replace('.', ' > ')}", "file": file, "line": item.location[1] + 1}
        if rep.passed:
            entry["status"] = "pass"
        elif rep.skipped:
            entry["status"] = "skip"
        else:
            entry["status"] = "fail"
            excinfo = call.excinfo
            message = str(excinfo.value) if excinfo else rep.longreprtext
            entry["failureKind"] = "runtime_error" if rep.when == "setup" else classify(excinfo.typename if excinfo else None, message)
            entry["message"] = _first_line(message)
        self.tests[item.nodeid] = entry

    def pytest_sessionfinish(self, session, exitstatus):
        if os.environ.get("GOVERNOR_DISABLE_REPORTER"):
            return
        record = {
            "v": 1,
            "runId": os.environ.get("GOVERNOR_RUN_ID") or str(uuid.uuid4()),
            "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "head": _git(self.root, "rev-parse", "HEAD") or "none",
            "adapter": "pytest",
            "exitCode": int(exitstatus),
            "collectionErrors": self.collection_errors,
            "tests": list(self.tests.values()),
        }
        ledger = Path(os.environ.get("GOVERNOR_LEDGER_PATH") or self.root / ".governor" / "ledger.jsonl")
        ledger.parent.mkdir(parents=True, exist_ok=True)
        with ledger.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")


def pytest_configure(config):
    if not config.pluginmanager.has_plugin("tdd-governor-recorder"):
        config.pluginmanager.register(_Recorder(Path(str(config.rootpath))), "tdd-governor-recorder")

