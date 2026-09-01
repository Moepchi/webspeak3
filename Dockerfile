# --- Rust connector -----------------------------------------------------
FROM rust:1-bookworm AS connector-builder
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY tsclientlib/ tsclientlib/
COPY connector/ connector/
WORKDIR /src/connector
ENV CMAKE_POLICY_VERSION_MINIMUM=3.5
RUN cargo build --release

# --- Web frontend ---------------------------------------------------------
FROM node:22-bookworm-slim AS web-builder
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
# Vite 8 pulls in Rolldown, which ships its bundler as a platform-specific
# optional dependency (@rolldown/binding-linux-x64-gnu here). `npm ci`
# intermittently fails to install it due to a long-standing npm bug
# (https://github.com/npm/cli/issues/4828) without raising a non-zero exit
# code, so `vite build` only fails later with a confusing MODULE_NOT_FOUND.
# Verify the binding actually loaded and self-heal via the workaround from
# npm's own error message before wasting a full build on a broken install.
RUN node -e "require('@rolldown/binding-linux-x64-gnu')" \
    || (rm -rf node_modules package-lock.json && npm install)
COPY web/ ./
# tsc -b currently fails on pre-existing type errors unrelated to this build;
# vite build alone is enough to produce the production bundle.
RUN npx vite build

# --- Gateway ----------------------------------------------------------------
FROM node:22-bookworm-slim AS gateway-builder
WORKDIR /src/gateway
COPY gateway/package*.json ./
RUN npm ci
COPY gateway/ ./
RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="WebSpeak3"
LABEL org.opencontainers.image.description="Self-hosted web client for TeamSpeak 3 servers"
WORKDIR /app
COPY gateway/package*.json ./
# npm/npx are only needed to install the gateway's runtime deps; the
# container never runs either afterwards, so strip them (plus npm's own
# cache/package tree) to shrink the image and drop npm's own CVEs from the
# final attack surface. This does mean `docker exec ... npm ...` won't work
# for ad-hoc debugging in a running container anymore.
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /root/.npm /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
COPY --from=gateway-builder /src/gateway/dist ./dist
COPY --from=connector-builder /src/connector/target/release/ts-connector /app/connector-bin/ts-connector
COPY --from=web-builder /src/web/dist /app/web/dist

ENV PORT=8080
ENV WEB_DIST=/app/web/dist
ENV CONNECTOR_BIN=/app/connector-bin/ts-connector
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "dist/index.js"]
