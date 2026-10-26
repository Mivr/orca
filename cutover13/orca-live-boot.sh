#!/usr/bin/env bash
# Boot hook (orca-live-boot.service): bring orca-live up on run-orca-live.sh's current image.
# orca-live has restart=no since cutover13, because its own entrypoint may be an older orcad that
# only survives as a PID-namespace keeper for an in-place swap. A running orca-live is never touched.
set -euo pipefail
for _ in $(seq 90); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
if [ "$(docker inspect -f '{{.State.Running}}' orca-live 2>/dev/null || true)" = true ]; then
  echo "orca-live already running; nothing to do"
  exit 0
fi
exec /bin/bash /home/mihail/orca-docker/run-orca-live.sh --yes
