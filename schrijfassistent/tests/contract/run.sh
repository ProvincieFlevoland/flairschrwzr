#!/usr/bin/env bash
# Runs the contract tests (pytest + httpx) against a started backend.
#   CONTRACT_BASE_URL (default http://localhost:8011)   CONTRACT_BEARER / CONTRACT_USER_BEARER (admin and user tokens)
#   CONTRACT_PYTHON   interpreter with pytest, httpx and azure-storage-blob (default: python3)
#   CONTRACT_BLOB_CONNECTION_STRING / CONTRACT_BLOB_CONTAINER   storage of the backend, for the raw-blob check
#   CONTRACT_OPENWEBUI_MOCK_LOG   call log of the Open WebUI stand-in, for the cache tests
# Extra arguments go to pytest (for example -k etag).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${CONTRACT_PYTHON:-python3}"
"$PY" -c "import pytest, httpx" 2>/dev/null || { echo "need pytest and httpx in $PY (pip install pytest httpx)"; exit 2; }
cd "$HERE"
PYTHONDONTWRITEBYTECODE=1 exec "$PY" -m pytest . "$@"
