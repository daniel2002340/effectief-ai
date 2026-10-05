#!/usr/bin/env sh
# Proves that the built images redact personal data in their logs (CLAUDE.md,
# logging; decision #070). Against the running local stack
# (docker-compose.stack.yml), through the edge:
#   1. signs up a user with a fake email address and name, and creates a company;
#   2. as its owner, triggers the test errors of api and worker (decision #069),
#      which carry another fake address, name and token in message and context;
#   3. waits until the worker job has failed on its last attempt;
#   4. checks that the logs of api and worker contain none of those values nor
#      the session token, but do contain the scrubbed error lines.
# Runs in CI (job "Images and local stack"); locally after pnpm stack:up.
set -eu

base="${STACK_URL:-http://localhost:8088}"
origin="${STACK_ORIGIN:-https://localhost:8088}"
compose="${COMPOSE:-docker compose -f docker-compose.yml -f docker-compose.stack.yml}"
# Only to parse the compose file for `logs`; nothing is built here.
export STACK_RELEASE="${STACK_RELEASE:-unused}"
run="$(date +%s)-$$"
email="redactie-${run}@example.test"
name="Redactie Pietersen"
# Must match monitoringTestData in packages/shared/src/monitoring.ts.
test_email='testfout.jansen@example.com'
test_name='Testfout Jansen'
test_token='testfout-token-not-a-secret'
failed=0

fail() { echo "FAIL $1" >&2; failed=1; }
ok() { echo "ok   $1"; }
post() { # <path> <json> [cookie]
  curl -s -D - -o /dev/null -X POST "$base$1" \
    -H 'content-type: application/json' -H "origin: $origin" \
    ${3:+-H "cookie: $3"} -d "$2"
}

# 1. Account and company. The cookie is Secure; curl gets it over plain http,
# so it is passed on by hand.
headers="$(post /api/auth/sign-up/email \
  "{\"name\":\"$name\",\"email\":\"$email\",\"password\":\"een-lang-wachtwoord\"}")"
cookie="$(printf '%s' "$headers" | tr -d '\r' \
  | sed -n 's/^[Ss]et-[Cc]ookie: \([^;]*session_token=[^;]*\).*/\1/p' | head -n 1)"
[ -n "$cookie" ] || { echo "FAIL sign-up gave no session cookie" >&2; exit 1; }
session_token="${cookie#*=}"
session_token="${session_token%%.*}"
status_line() { printf '%s' "$1" | head -n 1 | tr -d '\r'; }
created="$(post /api/auth/organization/create \
  "{\"name\":\"Redactie BV\",\"slug\":\"redactie-${run}\"}" "$cookie")"
case "$(status_line "$created")" in *" 200"*) ok 'company created' ;; *) fail "company: $(status_line "$created")" ;; esac

# 2. The test errors: api answers 500, worker queues a job that fails twice.
api="$(post /api/test/error '{"target":"api"}' "$cookie")"
case "$(status_line "$api")" in *" 500"*) ok 'api test error answered 500' ;; *) fail "api test error: $(status_line "$api")" ;; esac
worker="$(post /api/test/error '{"target":"worker"}' "$cookie")"
case "$(status_line "$worker")" in *" 200"*) ok 'worker test job queued' ;; *) fail "worker test job: $(status_line "$worker")" ;; esac

# 3. Two attempts with 0.5 s backoff; allow 30 s.
attempts=0
for _ in $(seq 1 30); do
  attempts="$($compose logs --no-color worker | grep '"msg":"job failed"' | grep -c 'monitoring-test' || true)"
  [ "$attempts" -ge 2 ] && break
  sleep 1
done
[ "$attempts" -ge 2 ] && ok 'worker test job failed twice' || fail "worker test job failed $attempts times, expected 2"

# 4. The logs of the bundles.
logs="$($compose logs --no-color api worker)"
for value in "$email" "$name" "$test_email" "$test_name" "$test_token" "$session_token"; do
  if printf '%s' "$logs" | grep -qF -- "$value"; then
    fail "logs contain a value that should be redacted (${#value} characters, starts with '$(printf '%s' "$value" | cut -c1-4)')"
  fi
done
[ "$failed" = 0 ] && ok 'no email address, name or token in the logs'
expect_line() { # <description> <fixed string>
  if printf '%s' "$logs" | grep -qF -- "$2"; then ok "$1"; else fail "$1: '$2' not in the logs"; fi
}
expect_line 'api logged the scrubbed error' '"message":"Testfout in api voor [redacted] <[email]>"'
expect_line 'worker logged the scrubbed error' '"message":"Testfout in worker voor [redacted] <[email]>"'
expect_line 'error context censored' '"token":"[redacted]"'
# A stack frame mistaken for an email address would make the stack unreadable.
if printf '%s' "$logs" | grep -qF -- '[email]:'; then fail 'a stack frame was scrubbed as an email address'; else ok 'stack frames readable'; fi

exit "$failed"
