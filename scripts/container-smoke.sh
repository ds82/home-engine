#!/bin/sh
# Container smoke test (container-image spec): builds the image and checks, against a mock
# Home Assistant in a second container,
#   - a read-only /rules with a package.json: dependencies are installed under /data, a
#     node_modules folder in /rules is ignored, and the rules load and work;
#   - the health check script passes;
#   - `docker stop` shuts down gracefully with exit code 0;
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
WORK=$(mktemp -d)

cleanup() {
  docker rm -f "$MOCK" "$ENGINE" "$ENGINE-fill" >/dev/null 2>&1 || true
  docker volume rm "$RULES" "$DATA" >/dev/null 2>&1 || true
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
cp -R docker/smoke/rules/. "$WORK/"
# A host-side node_modules (maybe for another CPU) that the engine must ignore.
mkdir -p "$WORK/node_modules/ms"
echo '{ "name": "ms", "version": "0.0.0-host", "main": "index.js" }' >"$WORK/node_modules/ms/package.json"
echo 'throw new Error("host node_modules in /rules was used");' >"$WORK/node_modules/ms/index.js"
docker create --name "$ENGINE-fill" -v "$RULES:/rules" "$IMAGE" >/dev/null
docker cp "$WORK/." "$ENGINE-fill:/rules/"
docker rm "$ENGINE-fill" >/dev/null

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

echo "==> Stopping the engine"
docker stop "$ENGINE" >/dev/null
code=$(docker inspect "$ENGINE" --format '{{.State.ExitCode}}')
[ "$code" = 0 ] || fail "docker stop exited with $code instead of 0"
docker logs "$ENGINE" 2>&1 | grep -q '"Shutdown complete"' || fail "no graceful shutdown"
docker rm "$ENGINE" >/dev/null

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
