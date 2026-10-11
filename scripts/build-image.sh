#!/bin/sh
# Builds the multi-arch image (linux/amd64 + linux/arm64) with buildx and checks the
# compressed size budget per platform (container-image: Minimal image, < 150 MB).
#
#   scripts/build-image.sh --dry-run                 build both platforms into an OCI archive,
#                                                    check platforms and sizes, push nothing
#   scripts/build-image.sh --push IMAGE TAG [TAG...] build, push IMAGE:TAG for every tag, then
#                                                    check the pushed manifests
#
# Needs docker with buildx and jq. No emulation: the Dockerfile cross-builds (see there).
set -eu

PLATFORMS=linux/amd64,linux/arm64
BUDGET=$((150 * 1024 * 1024))
BUILDER=${BUILDER:-home-engine-builder}
REVISION=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
VERSION=${VERSION:-0.0.0}

mode=${1:-}
case "$mode" in
  --dry-run) ;;
  --push)
    [ $# -ge 3 ] || { echo "usage: $0 --push IMAGE TAG [TAG...]" >&2; exit 2; }
    IMAGE=$2
    shift 2
    ;;
  *) echo "usage: $0 --dry-run | --push IMAGE TAG [TAG...]" >&2; exit 2 ;;
esac

# A docker-container builder can build several platforms into one manifest list.
docker buildx inspect "$BUILDER" >/dev/null 2>&1 ||
  docker buildx create --name "$BUILDER" --driver docker-container >/dev/null

# Prints "<platform> <compressed bytes>" per platform manifest. $1 is a command that prints
# a blob (index or manifest JSON) given its digest, or "index" for the top-level index.
sizes() {
  index=$($1 index)
  for digest in $(echo "$index" | jq -r '.manifests[] | select(.platform.os == "linux") | .digest'); do
    platform=$(echo "$index" | jq -r --arg d "$digest" \
      '.manifests[] | select(.digest == $d) | "\(.platform.os)/\(.platform.architecture)"')
    bytes=$($1 "$digest" | jq '[.config.size] + [.layers[].size] | add')
    echo "$platform $bytes"
  done
}

check() {
  report=$(sizes "$1")
  echo "$report" | awk '{ printf "  %-14s %6.1f MB compressed\n", $1, $2 / 1048576 }'
  for platform in $(echo "$PLATFORMS" | tr , ' '); do
    echo "$report" | grep -q "^$platform " || { echo "FAIL: no $platform image" >&2; exit 1; }
  done
  echo "$report" | while read -r platform bytes; do
    if [ "$bytes" -gt "$BUDGET" ]; then
      echo "FAIL: $platform is $bytes bytes compressed, over the budget of $BUDGET" >&2
      exit 1
    fi
  done
}

if [ "$mode" = --dry-run ]; then
  out=$(mktemp -d)
  trap 'command rm -rf "$out"' EXIT
  echo "==> Building $PLATFORMS (dry run, nothing is pushed)"
  docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" -f docker/Dockerfile \
    --build-arg VERSION="$VERSION" --build-arg REVISION="$REVISION" \
    --output "type=oci,dest=$out/image.tar" .
  mkdir "$out/oci"
  tar -xf "$out/image.tar" -C "$out/oci"
  blob() {
    if [ "$1" = index ]; then
      # The OCI layout's index points at the image index of the multi-platform build.
      top=$(jq -r '.manifests[0].digest' "$out/oci/index.json")
      cat "$out/oci/blobs/sha256/${top#sha256:}"
    else
      cat "$out/oci/blobs/sha256/${1#sha256:}"
    fi
  }
  check blob
else
  tags=""
  for tag in "$@"; do tags="$tags -t $IMAGE:$tag"; done
  echo "==> Building and pushing $PLATFORMS as$tags"
  # shellcheck disable=SC2086 # $tags is a list of -t options.
  docker buildx build --builder "$BUILDER" --platform "$PLATFORMS" -f docker/Dockerfile \
    --build-arg VERSION="$VERSION" --build-arg REVISION="$REVISION" $tags --push .
  remote() {
    if [ "$1" = index ]; then
      docker buildx imagetools inspect --raw "$IMAGE:$tag"
    else
      docker buildx imagetools inspect --raw "$IMAGE:$tag@$1"
    fi
  }
  check remote
fi
echo "PASS: image for $PLATFORMS within the size budget"
