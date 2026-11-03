"""Shared helpers of the contract tests: target selection, auth headers, blob-set expectation.

Environment (see README.md in schrijfassistent/):

  CONTRACT_BASE_URL            backend origin, default http://localhost:8011
  CONTRACT_BEARER              Open WebUI token of a user with the role admin (default test-admin-token, a token of
                               dev/mock/openwebui_auth_server.py)
  CONTRACT_USER_BEARER         token of a user with the role user (default test-user-token)
  CONTRACT_BLOB_CONNECTION_STRING / CONTRACT_BLOB_CONTAINER
                               storage the backend writes to, for the raw-blob checks; "" skips them
  CONTRACT_OPENWEBUI_MOCK_LOG  call log of the Open WebUI stand-in (dev/mock/openwebui_auth_server.py --log)
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

API_V1 = "/api/v1"
STORAGE = API_V1 + "/storage"


def base_url() -> str:
    return os.environ.get("CONTRACT_BASE_URL", "http://localhost:8011").rstrip("/")


def admin_token() -> str:
    return os.environ.get("CONTRACT_BEARER", "test-admin-token")


def user_token() -> str:
    return os.environ.get("CONTRACT_USER_BEARER", "test-user-token")


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def natural_key(s: Any) -> list:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(s))]


def natural_sort(items: list, key=lambda x: x) -> list:
    return sorted(items, key=lambda x: natural_key(key(x)))


def expected_blobs_for_upload(body: dict) -> list[str]:
    """Blob names that POST /upload-configuration creates for an upload body."""
    folder = list(body.keys())[0]
    cfg = body[folder]
    names = [f"{folder}/metadata.json"]
    for sub, items in cfg.get("mappen", {}).items():
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items):
            item_id = item.get("id") if isinstance(item, dict) else None
            names.append(f"{folder}/{sub}/{item_id}.json" if item_id else f"{folder}/{sub}/{index}.json")
    return names


def canonical_json(obj: Any) -> str:
    """How the backend serialises a nota (`ensure_ascii=False`)."""
    return json.dumps(obj, ensure_ascii=False)
