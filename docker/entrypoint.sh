#!/bin/sh
# Runs the engine, or `typegen [args]` to print typings for the configured Home Assistant.
# tini (PID 1) forwards signals and reaps children such as the npm installer.
set -e
if [ "$1" = "typegen" ]; then
  shift
  exec node /app/packages/typegen/dist/cli.js "$@"
fi
exec node /app/packages/engine/dist/cli.js "$@"
