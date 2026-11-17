# syntax=docker/dockerfile:1.10
# ─────────────────────────────────────────────────────────────────────────────
# Build — Node 26. SQLite is Node's built-in node:sqlite and sharp installs a
# prebuilt libvips for linux-musl from the lockfile, so no compiler toolchain.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# Keep only runtime dependencies.
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Runtime — Node server, non-root.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    DATA_DIR=/app/data

# Fixed ids, so a volume prepared on the host can be owned by them.
RUN addgroup -S -g 101 app && adduser -S -u 100 -G app app

COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/server.mjs ./server.mjs

# The SQLite file and avatars/ live here. Mount the named volume
# robyrew-id-data on this path in Dokploy, or every redeploy starts empty and
# every avatar URL in Logto points at a missing file.
RUN mkdir -p /app/data && chown app:app /app/data

USER app
EXPOSE 4321

# No exec healthcheck on vps01: exec probes leaked pids and kernel memory there
# (2026-09). The host's site probe calls /api/health instead.
HEALTHCHECK NONE

CMD ["node", "./server.mjs"]
