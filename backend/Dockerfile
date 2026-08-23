# backend/Dockerfile -- the API server image.
#
# Multi-stage so the runtime layer carries production dependencies only: no jest,
# no supertest, no fast-check. Those are ~40% of node_modules here and none of them
# should ship.
#
# alpine because every dependency is pure JavaScript -- bcryptjs and mysql2 are both
# JS implementations, not native bindings -- so there is nothing to compile and no
# need for a build toolchain or a glibc base image.

# ---------------------------------------------------------------------------------
# Stage 1: production dependencies
# ---------------------------------------------------------------------------------
FROM node:20-alpine AS deps

WORKDIR /app

# package.json and the lockfile only, so this layer is cached and `npm ci` re-runs
# just when a dependency actually changes -- not on every source edit.
COPY package.json package-lock.json ./

# `npm ci` not `npm install`: it installs exactly the lockfile, fails if
# package.json and the lockfile disagree, and never silently resolves a new
# version. That is what makes the image reproducible.
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------------
FROM node:20-alpine AS runtime

# Read by nothing in this codebase's own logic (no decision depends on it, per
# Req 10.5) but Express and several dependencies use it to disable development-only
# work such as verbose error rendering and view caching.
ENV NODE_ENV=production

# tini as PID 1. Node does handle SIGTERM as PID 1 when a handler is installed, and
# server.js installs one, so graceful shutdown works either way -- but PID 1 in Node
# does not reap orphaned child processes, and tini also guarantees the signal
# semantics rather than relying on them. It is 200KB for one less thing to reason
# about during a rolling deploy.
RUN apk add --no-cache tini

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# Only what the server actually runs. `tests/` is excluded by .dockerignore, and
# nothing here copies `.env` -- configuration arrives as real environment variables
# (see the note at the bottom of this file).
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# Drop root. The `node` image already provides an unprivileged `node` user, so this
# needs no useradd. Nothing in the container writes to disk: the app logs to stdout
# and stores everything in MySQL, so read-only ownership of /app is sufficient and
# the container can additionally be run with a read-only root filesystem.
USER node

# Matches the PORT default used throughout the project's documentation. EXPOSE is
# metadata only -- the actual port comes from the PORT environment variable, which
# the config loader requires and validates.
EXPOSE 4000

# The orchestrator's own check should point at /health/ready (see src/health.js).
# This one exists so `docker compose ps` and a plain `docker run` also report
# something truthful. start-period covers the migrate-and-wait phase in
# scripts/docker-start.js.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

# Waits for MySQL, applies schema.sql, then starts src/server.js. Set
# RUN_MIGRATIONS=false to skip the migration and run it as a separate one-off task
# instead -- see scripts/docker-start.js for when that matters.
CMD ["node", "scripts/docker-start.js"]

# ---------------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------------
# No ENV defaults are set for the eight required variables, and no .env file is
# copied in. That is deliberate and matches Req 10.3: the config loader applies no
# defaults and exits non-zero naming every missing variable, so a container started
# without its configuration fails immediately and loudly rather than booting with a
# silently wrong host or an empty JWT secret.
#
# Required at run time: MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD,
# MYSQL_DATABASE, JWT_SECRET, PORT, CORS_ORIGIN.
#
# JWT_SECRET and MYSQL_PASSWORD are secrets. Inject them from AWS Secrets Manager or
# SSM Parameter Store via the task definition's `secrets` block, never through
# `environment` (which is readable by anyone who can call DescribeTaskDefinition)
# and never through a build argument (which is recorded in the image history).
