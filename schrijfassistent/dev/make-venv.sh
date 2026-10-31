#!/usr/bin/env bash
# Creates a Python venv at $1 with the backend requirements ($2/requirements.txt) plus pytest and httpx,
# unless the venv is already complete. Needs `uv` and a package index (PyPI or a mirror).
#
#   bash schrijfassistent/dev/make-venv.sh <venv dir> schrijfassistent/backend
set -euo pipefail
VENV="$1"; BACKEND="$2"

if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c "import fastapi, azure.storage.blob, azure.identity, json_repair, pydantic_settings, httpx, pytest" 2>/dev/null; then
  echo "[venv] $VENV already complete"; exit 0
fi

uv venv --clear --python 3.13 "$VENV" >/dev/null
uv pip install --python "$VENV/bin/python" -r "$BACKEND/requirements.txt" pytest httpx >/dev/null
echo "[venv] installed in $VENV"
