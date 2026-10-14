#!/usr/bin/env bash
# Publishes the npm packages in dependency order: @home-engine/sdk, @home-engine/engine,
# @home-engine/typegen and home-engine (the CLI).
#
#   scripts/publish-npm.sh             build, test and publish
#   scripts/publish-npm.sh --dry-run   build, test and run `npm publish --dry-run`
#
# All packages must have the same version. A prerelease (1.0.0-alpha.1) is published under its
# identifier as dist-tag (alpha), a release under latest; NPM_TAG overrides it. Versions that
# are already on the registry are skipped, so the script can be rerun after a failure.
# Needs Node.js 24+ and `npm login` as a member of the home-engine org. npm prompts for a
# one-time password per package when 2FA is enabled.
set -euo pipefail

PACKAGES=(packages/sdk packages/engine packages/typegen packages/cli)

DRY_RUN=""
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN="--dry-run" ;;
  *)
    echo "Usage: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."

fail() {
  echo "publish-npm: $*" >&2
  exit 1
}

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "needs Node.js 24 or later, found $(node -v) (try: nvm use 24)"

if [ -z "$DRY_RUN" ]; then
  [ -z "$(git status --porcelain)" ] || fail "the working tree has uncommitted changes"
  user=$(npm whoami 2>/dev/null) || fail "not logged in to npm (run: npm login)"
  echo "Publishing as $user"
fi

version=$(node -p 'require("./packages/sdk/package.json").version')
for pkg in "${PACKAGES[@]}"; do
  v=$(node -p "require('./$pkg/package.json').version")
  [ "$v" = "$version" ] || fail "$pkg is at $v, expected $version"
done

if [ -n "${NPM_TAG:-}" ]; then
  tag=$NPM_TAG
elif [[ $version == *-* ]]; then
  prerelease=${version#*-}
  tag=${prerelease%%.*}
else
  tag=latest
fi
echo "Version $version, dist-tag $tag"

npm ci
npm run build
npm test

for pkg in "${PACKAGES[@]}"; do
  name=$(node -p "require('./$pkg/package.json').name")
  if [ -n "$(npm view "$name@$version" version 2>/dev/null)" ]; then
    echo "$name@$version is already published; skipping"
    continue
  fi
  echo "Publishing $name@$version"
  npm publish --workspace "$pkg" --access public --tag "$tag" $DRY_RUN
done

[ -n "$DRY_RUN" ] || echo "Done: npm install home-engine@$tag"
