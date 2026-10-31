#!/usr/bin/env bash
# Stops what run-test-stack.sh started in BUILD_DIR: the pids in BUILD_DIR/logs/*.pid and nothing else. Never by port, never by name.
set -uo pipefail
DEV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${BUILD_DIR:-/tmp/schrijfassistent-test-stack}"
for f in "$BUILD_DIR"/logs/*.pid; do
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  if [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null; then
    # setsid made the pid a process group leader: stop the group, fall back to the pid
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    # uvicorn waits for open keep-alive connections: wait up to 10 s for the pid, then force the group
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null; sleep 0.3; fi
    echo "stopped $(basename "$f" .pid) (pid $pid)"
  fi
  rm -f "$f"
done
rm -f "${RUNNING_FILE:-$DEV/.running-test-stack.json}"
echo "stack in $BUILD_DIR stopped"
