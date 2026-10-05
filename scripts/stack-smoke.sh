#!/usr/bin/env sh
# Checks the running local stack (docker-compose.stack.yml, decision #065)
# through the edge, the way a browser reaches staging:
#   - /health gives 200 with the release of this commit;
#   - an api procedure without a session gives 401;
#   - every response carries noindex, robots.txt disallows everything;
#   - source maps are not served.
# The RLS and role tests run separately: pnpm stack:verify.
#
# Also for staging after a deploy:
#   STACK_URL=https://staging.effectiefai.nl STACK_RELEASE=<deployed sha> scripts/stack-smoke.sh
set -eu

base="${STACK_URL:-http://localhost:8088}"
release="${STACK_RELEASE:-$(git rev-parse HEAD)}"
failed=0

check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1: expected '$2', got '$3'" >&2
    failed=1
  fi
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check '/health status' 200 "$(status "$base/health")"
check '/health release' "$release" \
  "$(curl -s "$base/health" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')"
check '/api/tenant without a session' 401 "$(status "$base/api/tenant")"
check 'POST /api/actions/approve without a session' 401 \
  "$(status -X POST -H 'content-type: application/json' -d '{}' "$base/api/actions/approve")"
for path in /health /api/tenant /; do
  check "noindex on $path" 'noindex, nofollow' \
    "$(curl -s -D - -o /dev/null "$base$path" | tr -d '\r' | sed -n 's/^[Xx]-[Rr]obots-[Tt]ag: //p')"
done
check 'robots.txt' 'Disallow: /' "$(curl -s "$base/robots.txt" | sed -n 2p)"
check 'source maps' 404 "$(status "$base/assets/index.js.map")"

exit "$failed"
