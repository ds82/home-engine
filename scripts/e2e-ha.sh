#!/bin/sh
# End-to-end test against a real Home Assistant in a container (task 18.1):
#   connect, state trigger → service call, virtual entity, hot reload, Home Assistant restart
#   with reconnect (subscriptions replayed, virtual entity republished), graceful shutdown.
# Home Assistant is onboarded by scripts/ha-onboard.mjs. Uses named volumes and runs every
# HTTP call in a container, so it works with docker-in-docker and needs only docker.
# Usage: scripts/e2e-ha.sh [image-tag]     HA_IMAGE overrides the Home Assistant image.
set -eu

IMAGE=${1:-home-engine:e2e}
HA_IMAGE=${HA_IMAGE:-ghcr.io/home-assistant/home-assistant:stable}
ID=$$
NET=he-e2e-net-$ID
HA=he-e2e-ha-$ID
ENGINE=he-e2e-engine-$ID
HA_CONFIG=he-e2e-haconfig-$ID
RULES=he-e2e-rules-$ID
DATA=he-e2e-data-$ID
HA_URL=http://homeassistant:8123
TOKEN=""

cleanup() {
  docker rm -f "$ENGINE" "$HA" "$HA-fill" >/dev/null 2>&1 || true
  docker volume rm "$HA_CONFIG" "$RULES" "$DATA" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- engine log (last 60 lines)" >&2
  docker logs --tail 60 "$ENGINE" >&2 2>&1 || true
  echo "--- Home Assistant log (last 30 lines)" >&2
  docker logs --tail 30 "$HA" >&2 2>&1 || true
  exit 1
}

step() { echo "==> $*"; }

# Waits up to $3 seconds for $2 to appear in the log of container $1.
wait_for_log() {
  i=0
  while [ "$i" -lt "$3" ]; do
    if docker logs "$1" 2>&1 | grep -q "$2"; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# Runs node (from the engine image) on the test network with HA_URL and the token set.
node_on_net() {
  docker run --rm -i --network "$NET" --entrypoint node -e HA_URL="$HA_URL" -e HA_TOKEN="$TOKEN" \
    "$IMAGE" --input-type=module "$@"
}

# ha_state ENTITY: prints the entity's state (empty if unknown).
ha_state() {
  node_on_net -e "
    const res = await fetch(process.env.HA_URL + '/api/states/$1', {
      headers: { authorization: 'Bearer ' + process.env.HA_TOKEN } });
    console.log(res.ok ? (await res.json()).state : '');"
}

# ha_service DOMAIN SERVICE ENTITY: calls a service on an entity.
ha_service() {
  node_on_net -e "
    const res = await fetch(process.env.HA_URL + '/api/services/$1/$2', { method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.HA_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ entity_id: '$3' }) });
    if (!res.ok) { console.error(res.status, await res.text()); process.exit(1); }"
}

# wait_for_state ENTITY STATE SECONDS
wait_for_state() {
  i=0
  while [ "$i" -lt "$3" ]; do
    [ "$(ha_state "$1")" = "$2" ] && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# put_rule FILE: copies FILE into the rules volume as e2e.ts (as root, like a user editing it).
put_rule() {
  docker run --rm -i --user 0 -v "$RULES:/rules" --entrypoint sh "$IMAGE" \
    -c 'cat > /rules/e2e.ts.tmp && mv /rules/e2e.ts.tmp /rules/e2e.ts' <"$1"
}

step "Building $IMAGE"
docker build -q -f docker/Dockerfile -t "$IMAGE" . >/dev/null

step "Starting Home Assistant ($HA_IMAGE)"
docker network create "$NET" >/dev/null
docker volume create "$HA_CONFIG" >/dev/null
docker volume create "$RULES" >/dev/null
docker volume create "$DATA" >/dev/null
docker create --name "$HA-fill" -v "$HA_CONFIG:/config" -v "$RULES:/rules" "$IMAGE" >/dev/null
docker cp docker/e2e/ha-config/. "$HA-fill:/config/"
docker cp docker/e2e/rules/. "$HA-fill:/rules/"
docker rm "$HA-fill" >/dev/null
docker run -d --name "$HA" --network "$NET" --network-alias homeassistant \
  -v "$HA_CONFIG:/config" "$HA_IMAGE" >/dev/null

step "Onboarding Home Assistant"
TOKEN=$(node_on_net - <scripts/ha-onboard.mjs) || fail "onboarding failed"
[ -n "$TOKEN" ] || fail "onboarding returned no token"
wait_for_state input_boolean.e2e_trigger off 120 || fail "input_boolean.e2e_trigger not available"

step "Starting the engine"
docker run -d --name "$ENGINE" --network "$NET" \
  -e HA_URL="$HA_URL" -e HA_TOKEN="$TOKEN" -e LOG_FORMAT=json \
  -v "$RULES:/rules:ro" -v "$DATA:/data" "$IMAGE" >/dev/null
wait_for_log "$ENGINE" '"Engine ready"' 120 || fail "engine did not become ready"
wait_for_log "$ENGINE" 'E2E rules loaded v1' 10 || fail "rules did not start"
docker logs "$ENGINE" 2>&1 | grep -q '"Connected to Home Assistant' || fail "no connection log"

step "State trigger → service call"
ha_service input_boolean turn_on input_boolean.e2e_trigger
wait_for_state input_boolean.e2e_target on 20 || fail "the relay rule did not turn the target on"
wait_for_log "$ENGINE" 'E2E relayed v1' 10 || fail "the relay rule did not log"
wait_for_state sensor.e2e_virtual v1 10 || fail "virtual entity not set"

step "Hot reload"
sed 's/const VERSION = "v1";/const VERSION = "v2";/' docker/e2e/rules/e2e.ts >"${TMPDIR:-/tmp}/e2e-v2-$ID.ts"
put_rule "${TMPDIR:-/tmp}/e2e-v2-$ID.ts"
command rm -f "${TMPDIR:-/tmp}/e2e-v2-$ID.ts"
wait_for_log "$ENGINE" 'E2E teardown v1' 30 || fail "the old rules were not unloaded"
wait_for_log "$ENGINE" 'E2E rules loaded v2' 30 || fail "the edited file was not reloaded"
wait_for_state sensor.e2e_virtual v2 10 || fail "the reloaded rule did not run"

step "Home Assistant restart and reconnect"
docker restart "$HA" >/dev/null
wait_for_log "$ENGINE" 'Lost connection to Home Assistant' 60 || fail "engine did not notice the restart"
wait_for_log "$ENGINE" '"Reconnected to Home Assistant' 180 || fail "engine did not reconnect"
wait_for_state input_boolean.e2e_trigger off 60 || fail "Home Assistant did not come back"
# The virtual entity is gone after the restart; the engine publishes it again.
wait_for_state sensor.e2e_virtual v2 60 || fail "the virtual entity was not republished"
# Subscriptions are replayed: the trigger works again.
ha_service input_boolean turn_off input_boolean.e2e_target
wait_for_state input_boolean.e2e_target off 10 || fail "could not reset the target"
ha_service input_boolean turn_on input_boolean.e2e_trigger
wait_for_state input_boolean.e2e_target on 20 || fail "the relay rule did not work after reconnect"
wait_for_log "$ENGINE" 'E2E relayed v2' 10 || fail "the relay rule did not log after reconnect"

step "Graceful shutdown"
docker stop "$ENGINE" >/dev/null
code=$(docker inspect "$ENGINE" --format '{{.State.ExitCode}}')
[ "$code" = 0 ] || fail "docker stop exited with $code instead of 0"
docker logs "$ENGINE" 2>&1 | grep -q 'E2E teardown v2' || fail "teardown did not run on shutdown"
docker logs "$ENGINE" 2>&1 | grep -q '"Shutdown complete"' || fail "no graceful shutdown"

echo "PASS: end-to-end test against Home Assistant"
