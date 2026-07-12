# syntax=docker/dockerfile:1
# ============================================================================
# server/Dockerfile — arm64 image for the Undercover authoritative game server.
#
# Multi-stage: install production-only deps in one cached layer, then copy them
# plus the source into a slim runtime that runs as the non-root `node` user.
#
# BUILD CONTEXT IS THE REPO ROOT (not server/), because the server imports the
# shared pure engine under js/. The CI builds with:
#     docker build -f server/Dockerfile .
# ============================================================================

# --- deps -------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
# Only the manifest first, so this layer stays cached until deps change. No lock
# file is committed, so `install` (not `ci`); --omit=dev keeps it to just `ws`.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# --- runtime ----------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Stamped by CI (defaults to "dev" for local builds); surfaced at /health.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# Production dependencies from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# App source: the manifest (marks the tree "type":"module"), the server, and the
# shared pure engine it imports from js/. Browser-only files under js/ are inert
# here — never imported server-side — so shipping them is harmless.
COPY package.json ./
COPY server ./server
COPY js ./js

# Drop privileges to the unprivileged user baked into the official node images.
USER node

EXPOSE 9000

# Liveness on the same endpoint the browser probes. Uses Node's http (no curl in
# alpine); `require` works in `node -e` even though the tree is ESM.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:9000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
