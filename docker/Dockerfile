# syntax=docker/dockerfile:1
# home-engine container image (design D11). Build from the repository root:
#   docker build -f docker/Dockerfile -t home-engine .
#
# Multi-arch without emulation: every RUN happens on the build machine's platform
# ($BUILDPLATFORM). The target platform's stage only copies files: production dependencies
# are installed for the target CPU (`npm ci --cpu`), and tini is a static binary.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- build
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/engine/package.json packages/engine/
COPY packages/typegen/package.json packages/typegen/
COPY examples/rules/package.json examples/rules/
RUN npm ci --no-audit --no-fund
COPY packages packages
RUN npm run build --workspace packages/sdk --workspace packages/engine --workspace packages/typegen

# ------------------------------------------------- production dependencies
# The build stage keeps its dev dependencies (the container smoke test runs the mock
# Home Assistant from it); this stage reduces them to what the runtime needs, for the target
# CPU. Install scripts are skipped: esbuild's only checks its binary, which cannot run here
# when cross-building.
FROM build AS deps
ARG TARGETARCH
ARG TINI_VERSION=v0.19.0
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) cpu=x64; tini=c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee ;; \
      arm64) cpu=arm64; tini=eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9 ;; \
      *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    npm ci --omit=dev --no-audit --no-fund --ignore-scripts --os=linux --cpu="$cpu" --libc=glibc; \
    rm -rf node_modules/.cache; \
    # npm nests a package's dependencies in its own node_modules when versions differ from
    # the root (e.g. chokidar); every package gets one so the runtime stage can copy it.
    mkdir -p packages/sdk/node_modules packages/engine/node_modules packages/typegen/node_modules; \
    mkdir -p /out/usr/bin /out/rules /out/data; \
    curl -fsSL -o /out/usr/bin/tini \
      "https://github.com/krallin/tini/releases/download/${TINI_VERSION}/tini-static-${TARGETARCH}"; \
    echo "$tini  /out/usr/bin/tini" | sha256sum -c -; \
    chmod 0755 /out/usr/bin/tini; \
    # /data belongs to the node user and group root, so any --user with GID 0 can write.
    chown 1000:0 /out/data; \
    chmod 2775 /out/data

# -------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim
ARG VERSION=0.0.0
ARG REVISION=unknown
LABEL org.opencontainers.image.title="home-engine" \
      org.opencontainers.image.description="Rule engine that runs TypeScript/JavaScript rules against Home Assistant" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/home-engine/home-engine" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    RULES_DIR=/rules \
    DATA_DIR=/data \
    HTTP_PORT=8080 \
    npm_config_cache=/data/.npm \
    npm_config_update_notifier=false

# tini, /rules and /data (ownership and modes come from the deps stage).
COPY --from=deps /out/ /
WORKDIR /app
COPY --from=deps /src/package.json ./
COPY --from=deps /src/node_modules node_modules
COPY --from=build /src/packages/sdk/package.json packages/sdk/
COPY --from=build /src/packages/sdk/dist packages/sdk/dist
COPY --from=deps /src/packages/sdk/node_modules packages/sdk/node_modules
COPY --from=build /src/packages/engine/package.json packages/engine/
COPY --from=build /src/packages/engine/dist packages/engine/dist
COPY --from=deps /src/packages/engine/node_modules packages/engine/node_modules
COPY --from=build /src/packages/typegen/package.json packages/typegen/
COPY --from=build /src/packages/typegen/dist packages/typegen/dist
COPY --from=deps /src/packages/typegen/node_modules packages/typegen/node_modules
COPY --chmod=0755 docker/entrypoint.sh /app/entrypoint.sh
COPY docker/healthcheck.js /app/healthcheck.js

VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
