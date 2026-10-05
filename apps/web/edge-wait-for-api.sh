#!/bin/sh
# Pre-deploy command of the edge (decision #064): waits until the api on the
# private network reports this image's release, so a new web app never goes
# live in front of an older api. Fails after 15 minutes.
set -eu

: "${API_UPSTREAM:?API_UPSTREAM is required}"
: "${APP_RELEASE:?APP_RELEASE is required}"

deadline=$(( $(date +%s) + 900 ))
while :; do
  if wget -qO- "http://${API_UPSTREAM}/health" 2>/dev/null | grep -q "\"release\":\"${APP_RELEASE}\""; then
    echo "api runs release ${APP_RELEASE}"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "api did not reach release ${APP_RELEASE} within 15 minutes" >&2
    exit 1
  fi
  echo "waiting for api release ${APP_RELEASE}"
  sleep 5
done
