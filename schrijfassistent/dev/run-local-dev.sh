#!/usr/bin/env bash
# Starts the Schrijfassistent backend for local development on a Mac or Linux machine.
#
#   bash schrijfassistent/dev/run-local-dev.sh          # start (idempotent); needs schrijfassistent/backend/.venv
#   bash schrijfassistent/dev/run-local-dev.sh stop     # stop what the script started
#
# Settings come from schrijfassistent/backend/.env (copy .env.example and fill it in; the file is git-ignored):
#   * .env present   -> real AI: PROJECT_ENDPOINT from the file, `az login` for the credential.
#                       Storage: if the file holds AZURE_STORAGE_CONNECTION_STRING the app uses that real storage;
#                       if it is empty the script starts a local blob emulator on :10001
#                       and seeds three fixture notas, so nothing is written to Azure.
#   * no .env        -> demo mode: recorded AI answers (dev/mock, only for the seeded notas) and the local emulator.
# The script always sets the local auth values: tokens are verified against the Open WebUI of docker-compose.local.yaml
# and CORS allows http://localhost:3000. Environment variables win over the .env file.
#
# Env overrides: PY (python with the backend requirements), BACKEND_PORT, BLOB_PORT, OPENWEBUI_URL, SEED_MOCK_PORT.
set -euo pipefail
DEV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DEV/../.." && pwd)"
STATE="$DEV/.local-dev"
BACKEND_PORT="${BACKEND_PORT:-8011}"
BLOB_PORT="${BLOB_PORT:-10001}"
SEED_MOCK_PORT="${SEED_MOCK_PORT:-8012}"
OPENWEBUI_URL="${OPENWEBUI_URL:-http://localhost:3000}"
ENVFILE="$REPO/schrijfassistent/backend/.env"
PY="${PY:-$REPO/schrijfassistent/backend/.venv/bin/python}"
CONTAINER_NAME="govchat-docs"
BLOB_CONN="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSrZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:$BLOB_PORT/devstoreaccount1;"
say() { printf '[local-dev] %s\n' "$*"; }

# Stops one process of this script by pid: SIGTERM, a short wait, then SIGKILL (a graceful stop of uvicorn can hang on an open
# connection and would leave the old backend on its port).
kill_pid() {
  local pid="$1"
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.2; done
  kill -9 "$pid" 2>/dev/null || true
}
stop_all() {
  for f in backend blob seed-auth; do
    if [ -f "$STATE/$f.pid" ]; then
      kill_pid "$(cat "$STATE/$f.pid")"
      rm -f "$STATE/$f.pid"
    fi
  done
}
if [ "${1:-}" = stop ]; then stop_all; say "stopped"; exit 0; fi

[ -x "$PY" ] || { echo "No python at $PY. Create the backend venv first (uv venv --python 3.12 schrijfassistent/backend/.venv, then uv pip install --python <that python> -r schrijfassistent/backend/requirements.lock httpx)."; exit 1; }
mkdir -p "$STATE"
stop_all

# value of a setting in the .env file (empty when the file or the line is missing)
envval() { [ -f "$ENVFILE" ] && sed -n "s/^$1=//p" "$ENVFILE" | head -1 | tr -d '\r"' || true; }

DEMO=0; EMULATOR=1; AI_PYTHONPATH=""
if [ ! -f "$ENVFILE" ]; then
  DEMO=1; AI_PYTHONPATH="$DEV/mock"
  say "no schrijfassistent/backend/.env: demo mode (recorded AI answers, only for the seeded notas)"
else
  [ -n "$(envval PROJECT_ENDPOINT)" ] || { echo "$ENVFILE has no PROJECT_ENDPOINT (see .env.example)"; exit 1; }
  if [ -n "$(envval AZURE_STORAGE_CONNECTION_STRING)" ]; then EMULATOR=0; fi
fi

wait_port() { local n=0; until (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null; do n=$((n+1)); [ $n -gt 60 ] && { echo "$2 did not open :$1"; tail -20 "$STATE/$3" 2>/dev/null; exit 1; }; sleep 0.5; done; }

STORAGE_ENV=()
if [ "$EMULATOR" = 1 ]; then
  nohup python3 "$DEV/blobemu/server.py" --port "$BLOB_PORT" --data-dir "$STATE/blob-data" </dev/null >"$STATE/blob.log" 2>&1 &
  echo $! >"$STATE/blob.pid"
  wait_port "$BLOB_PORT" "blob emulator" blob.log
  say "storage: local blob emulator on :$BLOB_PORT (nothing is written to Azure)"
  STORAGE_ENV=(AZURE_STORAGE_CONNECTION_STRING="$BLOB_CONN" AZURE_STORAGE_CONTAINER_NAME="$CONTAINER_NAME")
else
  say "storage: the real storage from $ENVFILE (notas and configurations there are read and written)"
fi

start_backend() { # $1 = Open WebUI URL the backend verifies tokens against
  (cd "$REPO/schrijfassistent/backend"
    env ${STORAGE_ENV[@]+"${STORAGE_ENV[@]}"} \
    OPENWEBUI_INTERNAL_URL="$1" OPENWEBUI_VERIFY_TIMEOUT_SEC="3" \
    CORS_ALLOW_ORIGINS="http://localhost:3000" \
    PYTHONPATH="$AI_PYTHONPATH" PYTHONDONTWRITEBYTECODE=1 AI_MOCK_FIXTURES_DIR="$DEV/fixtures" \
    AI_MOCK_LOG="$STATE/ai-mock-calls.jsonl" \
    nohup "$PY" -m uvicorn main:app --host 127.0.0.1 --port "$BACKEND_PORT" </dev/null >"$STATE/backend.log" 2>&1 &
    echo $! >"$STATE/backend.pid")
  local n=0; until curl -fsS "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 60 ] && { echo "backend not healthy"; tail -30 "$STATE/backend.log"; exit 1; }; sleep 0.5; done
}
stop_backend() {
  if [ -f "$STATE/backend.pid" ]; then
    kill_pid "$(cat "$STATE/backend.pid")"
    rm -f "$STATE/backend.pid"
  fi
}

if [ "$EMULATOR" = 1 ]; then
  # Every route verifies a token, so the seed needs an admin token. A short-lived stand-in for Open WebUI
  # answers for it while the fixtures are written; the backend is then restarted against the real Open WebUI.
  nohup python3 "$DEV/mock/openwebui_auth_server.py" --port "$SEED_MOCK_PORT" </dev/null >"$STATE/seed-auth.log" 2>&1 &
  echo $! >"$STATE/seed-auth.pid"
  wait_port "$SEED_MOCK_PORT" "seed auth stand-in" seed-auth.log
  start_backend "http://127.0.0.1:$SEED_MOCK_PORT"
  (cd "$DEV" && SEED_BASE_URL="http://127.0.0.1:$BACKEND_PORT" SEED_BEARER="test-admin-token" AZURE_STORAGE_CONNECTION_STRING="$BLOB_CONN" \
    AZURE_STORAGE_CONTAINER_NAME="$CONTAINER_NAME" "$PY" seed.py)
  say "seeded three fixture notas and the GS-nota v5 configuration"
  stop_backend
  kill_pid "$(cat "$STATE/seed-auth.pid")"; rm -f "$STATE/seed-auth.pid"
fi
start_backend "$OPENWEBUI_URL"
say "backend on http://localhost:$BACKEND_PORT (tokens verified against $OPENWEBUI_URL, AI: $([ "$DEMO" = 1 ] && echo 'recorded fixtures' || echo 'real, from .env'))"
say "ready. Stop with: bash schrijfassistent/dev/run-local-dev.sh stop"
