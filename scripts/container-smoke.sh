#!/bin/sh
# Container smoke test (container-image spec): builds the image and checks, against a mock
# Home Assistant in a second container,
#   - a read-only /rules with a package.json: dependencies are installed under /data, a
#     node_modules folder in /rules is ignored, and the rules load and work;
#   - the health check script passes;
#   - tini reaps orphaned processes: no zombies are left;
#   - `docker stop` shuts down gracefully with exit code 0;
#   - an engine whose event loop is blocked is reported unhealthy;
#   - the Compose quick start (examples/) runs the hello rule;
#   - an unwritable /data stops the engine with a message naming /data and the UID.
# Uses named volumes instead of bind mounts, so it also works with docker-in-docker.
# Usage: scripts/container-smoke.sh [image-tag]
set -eu

IMAGE=${1:-home-engine:smoke}
ID=$$
NET=he-smoke-net-$ID
RULES=he-smoke-rules-$ID
DATA=he-smoke-data-$ID
MOCK=he-smoke-mock-$ID
ENGINE=he-smoke-engine-$ID
BLOCK=he-smoke-block-$ID
QUICK=he-smoke-quick-$ID
WORK=$(mktemp -d)

compose() {
  HOME_ENGINE_IMAGE=$IMAGE HA_URL=http://homeassistant:8123 HA_TOKEN=smoke-token \
    docker compose -p "$QUICK" -f examples/docker-compose.yml -f "$WORK/quick-start.yml" "$@"
}

cleanup() {
  [ -f "$WORK/quick-start.yml" ] && compose down -v >/dev/null 2>&1 || true
  docker rm -f -v "$MOCK" "$ENGINE" "$ENGINE-fill" "$BLOCK" >/dev/null 2>&1 || true
  docker volume rm "$RULES" "$DATA" "$BLOCK" "$QUICK" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  command rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- engine log" >&2
  docker logs "$ENGINE" >&2 2>&1 || true
  echo "--- mock log" >&2
  docker logs "$MOCK" >&2 2>&1 || true
  exit 1
}

# Copies the contents of directory $2 into volume $1.
fill_volume() {
  docker create --name "$ENGINE-fill" -v "$1:/rules" "$IMAGE" >/dev/null
  docker cp "$2/." "$ENGINE-fill:/rules/"
  docker rm "$ENGINE-fill" >/dev/null
}

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

echo "==> Building $IMAGE and its build stage"
docker build -q -f docker/Dockerfile -t "$IMAGE" . >/dev/null
docker build -q -f docker/Dockerfile --target build -t "$IMAGE-build" . >/dev/null

echo "==> Preparing volumes"
docker network create "$NET" >/dev/null
docker volume create "$RULES" >/dev/null
docker volume create "$DATA" >/dev/null
mkdir -p "$WORK/rules"
cp -R docker/smoke/rules/. "$WORK/rules/"
# A host-side node_modules (maybe for another CPU) that the engine must ignore.
mkdir -p "$WORK/rules/node_modules/ms"
echo '{ "name": "ms", "version": "0.0.0-host", "main": "index.js" }' >"$WORK/rules/node_modules/ms/package.json"
echo 'throw new Error("host node_modules in /rules was used");' >"$WORK/rules/node_modules/ms/index.js"
fill_volume "$RULES" "$WORK/rules"

echo "==> Starting the mock Home Assistant"
docker create --name "$MOCK" --network "$NET" --network-alias homeassistant \
  "$IMAGE-build" node /src/mock-ha.mjs >/dev/null
docker cp docker/smoke/mock-ha.mjs "$MOCK:/src/mock-ha.mjs"
docker start "$MOCK" >/dev/null
wait_for_log "$MOCK" MOCK_READY 30 || fail "mock Home Assistant did not start"

echo "==> Starting the engine with a read-only /rules"
docker run -d --name "$ENGINE" --network "$NET" \
  -e HA_URL=http://homeassistant:8123 -e HA_TOKEN=smoke-token -e LOG_FORMAT=json \
  -v "$RULES:/rules:ro" -v "$DATA:/data" "$IMAGE" >/dev/null
wait_for_log "$ENGINE" '"Engine ready"' 180 || fail "engine did not become ready"
docker logs "$ENGINE" 2>&1 | grep -q '"Rule dependencies installed"' ||
  fail "rule dependencies were not installed"
docker logs "$ENGINE" 2>&1 | grep -q 'two days are 172800000 ms' ||
  fail "the rule did not use the dependency installed under /data"
docker logs "$ENGINE" 2>&1 | grep -q '"Rules: 2 loaded, 0 disabled, 0 failed"' ||
  fail "not all rules loaded"
[ "$(docker exec "$ENGINE" id -u)" != 0 ] || fail "the engine runs as root"
docker exec "$ENGINE" node /app/healthcheck.js || fail "the health check failed"
wait_for_log "$MOCK" LIGHT_ON 30 || fail "the porch rule did not turn on the light"

echo "==> Checking that orphaned processes are reaped"
# The shell exits at once; its background child is orphaned and reparented to PID 1.
docker exec "$ENGINE" sh -c 'sleep 1 & exit 0'
sleep 3
# The image has no ps: read the state field of every /proc/<pid>/stat.
zombies=$(docker exec "$ENGINE" sh -c \
  'for f in /proc/[0-9]*/stat; do sed "s/.*) //" "$f" 2>/dev/null | cut -d" " -f1; done' |
  grep -c Z || true)
[ "$zombies" = 0 ] || fail "$zombies zombie process(es) left in the container"

echo "==> Stopping the engine"
docker stop "$ENGINE" >/dev/null
code=$(docker inspect "$ENGINE" --format '{{.State.ExitCode}}')
[ "$code" = 0 ] || fail "docker stop exited with $code instead of 0"
docker logs "$ENGINE" 2>&1 | grep -q '"Shutdown complete"' || fail "no graceful shutdown"
docker rm "$ENGINE" >/dev/null

echo "==> Checking that an engine with a blocked event loop turns unhealthy"
mkdir -p "$WORK/block"
cat >"$WORK/block/block.ts" <<'RULE'
import { onStartup, rule } from "@home-engine/sdk";
rule("block", onStartup(), () => {
  for (;;) {
    // never yields
  }
});
RULE
docker volume create "$BLOCK" >/dev/null
fill_volume "$BLOCK" "$WORK/block"
docker run -d --name "$BLOCK" --network "$NET" \
  -e HA_URL=http://homeassistant:8123 -e HA_TOKEN=smoke-token -e LOG_FORMAT=json \
  --health-interval=2s --health-timeout=2s --health-retries=2 --health-start-period=1s \
  -v "$BLOCK:/rules:ro" "$IMAGE" >/dev/null
i=0
status=
while [ "$i" -lt 60 ]; do
  status=$(docker inspect "$BLOCK" --format '{{.State.Health.Status}}')
  [ "$status" = unhealthy ] && break
  i=$((i + 1))
  sleep 1
done
[ "$status" = unhealthy ] || fail "the blocked engine is $status, not unhealthy"
docker rm -f -v "$BLOCK" >/dev/null

echo "==> Running the Compose quick start"
docker volume create "$QUICK" >/dev/null
fill_volume "$QUICK" examples/rules
# Same Compose file as in the README; only what the test environment needs is changed: the
# mock Home Assistant's network, a named volume for the rules (works with docker-in-docker)
# and no host port.
cat >"$WORK/quick-start.yml" <<YAML
services:
  home-engine:
    environment:
      LOG_FORMAT: json
    volumes: !override
      - quick-rules:/rules:ro
      - home-engine-data:/data
    ports: !reset []
    networks: [smoke]
networks:
  smoke:
    external: true
    name: $NET
volumes:
  quick-rules:
    external: true
    name: $QUICK
YAML
compose up -d --quiet-pull >/dev/null 2>&1 || fail "docker compose up failed: $(compose up -d 2>&1)"
container=$(compose ps -q home-engine)
wait_for_log "$container" 'home-engine is running and sees' 120 ||
  fail "the quick start did not log the hello greeting: $(docker logs "$container" 2>&1 | tail -20)"
compose down -v >/dev/null 2>&1
rm -f "$WORK/quick-start.yml"

echo "==> Starting with an unwritable /data"
set +e
out=$(docker run --rm --user 4321:4321 -v "$RULES:/rules:ro" -v "$DATA:/data" \
  -e HA_URL=http://homeassistant:8123 -e HA_TOKEN=smoke-token "$IMAGE" 2>&1)
code=$?
set -e
[ "$code" != 0 ] || fail "the engine started with an unwritable /data"
echo "$out" | grep -q "DATA_DIR: directory /data is not writable by UID 4321" ||
  fail "unexpected message for an unwritable /data: $out"

echo "PASS: container smoke test"
