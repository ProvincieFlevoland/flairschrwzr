"""Fixtures of the contract tests: an HTTP client for the backend under test and the admin auth headers.

The tests run against a started backend (`CONTRACT_BASE_URL`), see common.py for the environment and
schrijfassistent/README.md for how to start one.
"""
from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path

import httpx
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import common as cc  # noqa: E402

FIXTURES = HERE.parents[1] / "dev" / "fixtures"


@pytest.fixture(scope="session")
def env():
    return {"base_url": cc.base_url()}


@pytest.fixture(scope="session")
def client(env):
    with httpx.Client(base_url=env["base_url"], timeout=60) as c:
        try:
            c.get("/health").raise_for_status()
        except Exception as e:  # pragma: no cover - environment problem
            pytest.exit(f"backend {env['base_url']} is not reachable: {e}", returncode=2)
        yield c


@pytest.fixture(scope="session")
def auth():
    """Headers of an Open WebUI admin, sent on every storage call."""
    return cc.bearer(cc.admin_token())


@pytest.fixture
def scratch_id():
    """Unique id for notas and configurations a test creates; the test deletes them in `finally`."""
    return "test-" + uuid.uuid4().hex[:12]


def load_fixture(*parts: str):
    return json.loads((FIXTURES.joinpath(*parts)).read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def fixtures():
    return load_fixture
