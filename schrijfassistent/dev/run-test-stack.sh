#!/usr/bin/env bash
# Starts a private stack for the contract and e2e tests on ports of your own choosing, and stops only what it
# started (pid files). It never stops anything by port or by name, so it is safe next to other servers.
#
#   BUILD_DIR=/tmp/sa-stack bash schrijfassistent/dev/run-test-stack.sh     # start (stops its own old pids first)
#   BUILD_DIR=/tmp/sa-stack bash schrijfassistent/dev/stop-test-stack.sh    # stop (pid files only)
#
# Parts (PARTS, default all):
#   blob      the blob emulator (dev/blobemu)
#   ow        the Open WebUI token stand-in (dev/mock/openwebui_auth_server.py) with the tokens below
#   backend   the backend from SOURCE_TREE, AI answers replayed from dev/fixtures (dev/mock)
#   seed      the GS-nota v5 configuration and three fixture notas, written through the API
#   dev       the bundle's dev harness (schrijfassistent/frontend/dev); needs `npm run build` first
#   hostsim   an Open WebUI stand-in that serves the real loader.js and the bundle in front of the backend
#
# Tokens of the stand-in: test-admin-token (role admin), test-user-token (role user), auteur-token (role user),
# beheerder-token (role admin), outsider-token (role user).
#
# Ports (environment): BACKEND_PORT 8071, OW_PORT 8072, BLOB_PORT 10071, DEV_PORT 3070, HOSTSIM_PORT 3071.
# A part whose port is taken is not started. SOURCE_TREE (default: this repository) is the tree to run.
# VENV_DIR is a Python venv with the backend requirements, pytest and httpx (default: BUILD_DIR/.venv, created by
# make-venv.sh). Writes RUNNING_FILE (default dev/.running-test-stack.json) with the addresses, one JSON object.
set -euo pipefail
DEV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DEFAULT="$(cd "$DEV/../.." && pwd)"
SOURCE_TREE="${SOURCE_TREE:-$REPO_DEFAULT}"
BUILD_DIR="${BUILD_DIR:-/tmp/schrijfassistent-test-stack}"
PARTS="${PARTS:-blob ow backend seed dev hostsim}"
BACKEND_PORT="${BACKEND_PORT:-8071}"
OW_PORT="${OW_PORT:-8072}"
BLOB_PORT="${BLOB_PORT:-10071}"
DEV_PORT="${DEV_PORT:-3070}"
HOSTSIM_PORT="${HOSTSIM_PORT:-3071}"
CORS_ALLOW_ORIGINS="${CORS_ALLOW_ORIGINS:-http://localhost:$DEV_PORT,http://localhost:$HOSTSIM_PORT}"
CONTAINER_NAME="${AZURE_STORAGE_CONTAINER_NAME:-govchat-docs}"
# The well-known development account of the Azure Storage emulators (public, not a secret), bound to BLOB_PORT.
BLOB_CONN="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSrZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:$BLOB_PORT/devstoreaccount1;"
VENV_DIR="${VENV_DIR:-$BUILD_DIR/.venv}"
RUNNING="${RUNNING_FILE:-$DEV/.running-test-stack.json}"
LOGS="$BUILD_DIR/logs"
mkdir -p "$BUILD_DIR" "$LOGS"

say() { printf '\033[0;32m[test-stack]\033[0m %s\n' "$*"; }
has() { case " $PARTS " in *" $1 "*) return 0;; esac; return 1; }
port_free() { ! (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
need_free() { port_free "$1" || { echo "port $1 ($2) is already taken: choose another port, this script never stops a stranger"; exit 1; }; }
wait_port() { local n=0; until (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null; do n=$((n+1)); [ $n -gt 80 ] && { echo "$2 did not open :$1"; tail -20 "$LOGS/$3" 2>/dev/null; exit 1; }; sleep 0.5; done; }
wait_http() { local n=0; until curl -fsS "$1" >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 80 ] && { echo "$1 not healthy"; tail -30 "$LOGS/${2:-backend.log}"; exit 1; }; sleep 0.5; done; }

# stop what an earlier run of THIS build dir started (pid files only)
BUILD_DIR="$BUILD_DIR" RUNNING_FILE="$RUNNING" bash "$DEV/stop-test-stack.sh" >/dev/null 2>&1 || true

[ -d "$SOURCE_TREE/schrijfassistent/backend" ] || { echo "SOURCE_TREE $SOURCE_TREE has no schrijfassistent/backend"; exit 1; }
BACKEND="$BUILD_DIR/backend"
mkdir -p "$BACKEND"
(cd "$SOURCE_TREE/schrijfassistent/backend" && tar --exclude=.venv --exclude=__pycache__ --exclude=static --exclude=.env -cf - .) | (cd "$BACKEND" && tar -xf -)
rm -f "$BACKEND/.env"
bash "$DEV/make-venv.sh" "$VENV_DIR" "$BACKEND" >/dev/null
PY="$VENV_DIR/bin/python"
start() { # name, command...
  local name="$1"; shift
  ( exec nohup setsid "$@" </dev/null >"$LOGS/$name.log" 2>&1 ) & echo $! >"$LOGS/$name.pid"
}

if has blob; then
  need_free "$BLOB_PORT" "blob emulator"
  start blob python3 "$DEV/blobemu/server.py" --port "$BLOB_PORT" --data-dir "$BUILD_DIR/blobemu-data"
  wait_port "$BLOB_PORT" "blob emulator" blob.log
  say "blob emulator on :$BLOB_PORT"
fi
if has ow; then
  need_free "$OW_PORT" "open webui stand-in"
  cat >"$BUILD_DIR/tokens.json" <<JSON
{
  "auteur-token":    {"id": "u-auteur",   "email": "auteur@example.test",     "name": "Test Auteur",     "role": "user"},
  "beheerder-token": {"id": "u-beheerder", "email": "beheerder@example.test", "name": "Test Beheerder",  "role": "admin"},
  "outsider-token":  {"id": "u-outsider", "email": "outsider@example.test",   "name": "Outsider",        "role": "user"}
}
JSON
  start openwebui-mock python3 "$DEV/mock/openwebui_auth_server.py" --port "$OW_PORT" --tokens "$BUILD_DIR/tokens.json" --log "$BUILD_DIR/openwebui-mock-calls.jsonl"
  wait_port "$OW_PORT" "open webui stand-in" openwebui-mock.log
  say "open webui stand-in on :$OW_PORT"
fi
if has backend; then
  need_free "$BACKEND_PORT" "backend"
  # `( ... exec ... ) &`: the subshell is replaced by the server, so $! is the server's own pid (the pid file must name the server, not a wrapper)
  ( cd "$BACKEND" && exec env AZURE_STORAGE_CONNECTION_STRING="$BLOB_CONN" AZURE_STORAGE_CONTAINER_NAME="$CONTAINER_NAME" \
      PROJECT_ENDPOINT= OPENWEBUI_INTERNAL_URL="http://127.0.0.1:$OW_PORT" OPENWEBUI_VERIFY_TIMEOUT_SEC=3 \
      CORS_ALLOW_ORIGINS="$CORS_ALLOW_ORIGINS" SCHRIJFASSISTENT_ENV_FILE= \
      PYTHONPATH="$DEV/mock" PYTHONDONTWRITEBYTECODE=1 AI_MOCK_FIXTURES_DIR="$DEV/fixtures" AI_MOCK_LOG="$BUILD_DIR/ai-mock-calls.jsonl" \
      nohup setsid "$PY" -m uvicorn main:app --host 127.0.0.1 --port "$BACKEND_PORT" </dev/null >"$LOGS/backend.log" 2>&1 ) & echo $! >"$LOGS/backend.pid"
  wait_http "http://127.0.0.1:$BACKEND_PORT/health" backend.log
  say "backend on :$BACKEND_PORT"
fi
if has seed; then
  has backend || { echo "seed needs the backend part"; exit 1; }
  (cd "$DEV" && SEED_BASE_URL="http://127.0.0.1:$BACKEND_PORT" SEED_BEARER="beheerder-token" AZURE_STORAGE_CONNECTION_STRING="$BLOB_CONN" AZURE_STORAGE_CONTAINER_NAME="$CONTAINER_NAME" "$PY" seed.py) >"$LOGS/seed.log" 2>&1 || { cat "$LOGS/seed.log"; exit 1; }
  say "seeded"
fi
if has dev; then
  need_free "$DEV_PORT" "dev harness"
  [ -d "$SOURCE_TREE/schrijfassistent/frontend/dist" ] || { echo "no dist in $SOURCE_TREE/schrijfassistent/frontend: run npm run build first"; exit 1; }
  ( cd "$SOURCE_TREE/schrijfassistent/frontend" && PORT="$DEV_PORT" exec nohup setsid node dev/serve.mjs </dev/null >"$LOGS/dev.log" 2>&1 ) & echo $! >"$LOGS/dev.pid"
  wait_port "$DEV_PORT" "dev harness" dev.log
  say "dev harness on :$DEV_PORT"
fi
if has hostsim; then
  need_free "$HOSTSIM_PORT" "hostsim"
  start hostsim node "$DEV/../tests/e2e/hostsim/serve.mjs" --repo "$SOURCE_TREE" --port "$HOSTSIM_PORT" --upstream "http://127.0.0.1:$BACKEND_PORT" --ow "http://127.0.0.1:$OW_PORT" --data "$BUILD_DIR/hostsim-data"
  wait_port "$HOSTSIM_PORT" "hostsim" hostsim.log
  say "host stand-in on :$HOSTSIM_PORT -> backend :$BACKEND_PORT"
fi

cat >"$RUNNING" <<JSON
{
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_tree": "$SOURCE_TREE",
  "build_dir": "$BUILD_DIR",
  "backend_url": "http://localhost:$BACKEND_PORT",
  "openwebui_mock_url": "http://127.0.0.1:$OW_PORT",
  "openwebui_mock_log": "$BUILD_DIR/openwebui-mock-calls.jsonl",
  "blob_connection_string": "$BLOB_CONN",
  "container_name": "$CONTAINER_NAME",
  "dev_url": "http://localhost:$DEV_PORT/",
  "hostsim_url": "http://localhost:$HOSTSIM_PORT/",
  "ai_mock_log": "$BUILD_DIR/ai-mock-calls.jsonl",
  "logs": "$LOGS"
}
JSON
say "running; details in $RUNNING"
