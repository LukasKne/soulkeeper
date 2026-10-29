#!/usr/bin/env bash
# Uses an isolated, disposable database. Never point this at a deployed tracker.
set -euo pipefail
image=${1:-soulkeeper:local}
smoke_id="soulkeeper-smoke-$(date +%s)-$$"
smoke_env=$(mktemp)
cleanup() {
  docker rm -f "$smoke_id" >/dev/null 2>&1 || true
  docker volume rm "$smoke_id" >/dev/null 2>&1 || true
  rm -f "$smoke_env"
}
trap cleanup EXIT
python3 - "$smoke_env" <<'PY'
import secrets, sys
from pathlib import Path
Path(sys.argv[1]).write_text(
    f'LUKAS_PASSWORD={secrets.token_urlsafe(24)}\n'
    f'OLI_PASSWORD={secrets.token_urlsafe(24)}\n'
    'APP_ORIGIN=http://127.0.0.1:18085\nCOOKIE_SECURE=false\n'
)
PY
start_container() {
  docker run -d --name "$smoke_id" --env-file "$smoke_env" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -p 127.0.0.1:18085:8000 -v "$smoke_id:/data" "$image" >/dev/null
  for attempt in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:18085/healthz >/dev/null 2>&1; then return; fi
    sleep 1
  done
  docker logs "$smoke_id"
  return 1
}
start_container
python3 scripts/smoke.py "$smoke_env" before
docker stop "$smoke_id" >/dev/null
docker rm "$smoke_id" >/dev/null
start_container
python3 scripts/smoke.py "$smoke_env" after
