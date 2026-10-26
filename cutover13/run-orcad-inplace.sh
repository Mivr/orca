#!/bin/sh
# Runs a newer orcad INSIDE an already-running orca-live container (via `docker exec -d`), next to
# the retired old orcad that stays alive as the container's PID-namespace keeper (see
# ~/orca-docker/cutover13/CUTOVER13-LOG.md). Restarts orcad on a crash; exit 78 (configuration:
# lock held, bad data root) and a STOP file end the loop. Stop it with:
#   touch <slot>/STOP && docker exec orca-live pkill -TERM -f "<slot>/app/orcad.js"
SLOT=$(cd "$(dirname "$0")" && pwd)
NODE="$SLOT/runtimes/$(ls "$SLOT/runtimes" | head -n1)/bin/node"
LOG="${ORCA_USER_DATA:?}/logs/orcad-inplace.log"
rm -f "$SLOT/STOP"
while :; do
  echo "[orcad-inplace] start $(date -Is) slot=$SLOT" >>"$LOG"
  "$NODE" "$SLOT/app/orcad.js" "$@" >>"$LOG" 2>&1
  rc=$?
  echo "[orcad-inplace] exit rc=$rc $(date -Is)" >>"$LOG"
  [ -f "$SLOT/STOP" ] && exit "$rc"
  [ "$rc" -eq 78 ] && exit "$rc"
  sleep 5
done
