#!/bin/sh
# Caddy replaces a missing {$VAR} with an empty string instead of failing, so
# the variables are checked here: a misconfigured edge does not start.
set -eu

case "${PORT:-}" in
  '' | *[!0-9]*) echo "PORT must be a port number" >&2; exit 1 ;;
esac
# host:port, e.g. api.railway.internal:3000 or [fd12::1]:3000
if ! printf '%s' "${API_UPSTREAM:-}" | grep -Eq '^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):[0-9]+$'; then
  echo "API_UPSTREAM must be host:port" >&2
  exit 1
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
