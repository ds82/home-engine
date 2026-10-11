# syntax=docker/dockerfile:1
# home-engine container image (design D11). Build from the repository root:
#   docker build -f docker/Dockerfile -t home-engine .

ARG NODE_VERSION=24

# ---------------------------------------------------------------- build
FROM node:${NODE_VERSION}-bookworm AS build
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
# Home Assistant from it); this stage reduces them to what the runtime needs.
FROM build AS deps
# npm nests a package's dependencies in its own node_modules when versions differ from the
# root (e.g. chokidar); make sure every package has one so the runtime stage can copy it.
RUN npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/.cache \
 && mkdir -p packages/sdk/node_modules packages/engine/node_modules packages/typegen/node_modules

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

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    RULES_DIR=/rules \
    DATA_DIR=/data \
    HTTP_PORT=8080 \
    npm_config_cache=/data/.npm \
    npm_config_update_notifier=false

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
COPY docker/entrypoint.sh docker/healthcheck.js ./

# /data belongs to the node user and group root, so any --user with GID 0 can write to it.
RUN mkdir -p /rules /data \
 && chown node:0 /data && chmod 2775 /data \
 && chmod 0755 /app/entrypoint.sh

VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
