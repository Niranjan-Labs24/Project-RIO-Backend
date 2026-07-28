# syntax=docker/dockerfile:1
# Pinned to a reviewed digest (Task 9, container hardening) rather than the
# floating `node:24-slim` tag, so a rebuild can't silently pull a different
# image. Re-pin deliberately (docker pull node:24-slim && docker inspect ...)
# when a genuine upgrade is wanted — never widen this back to a bare tag.
FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Prisma 7 custom client output (src/generated/prisma) is gitignored and must
# be generated at build time. `nest build` (via nest-cli.json assets config)
# copies the generated JS/wasm runtime files into dist/generated/prisma —
# there is no native query-engine binary to worry about: the client uses a
# bundled wasm query compiler and talks to Postgres through the @prisma/adapter-pg
# driver adapter, both of which ship as regular npm packages.
# `prisma generate` only reads prisma/schema.prisma to emit the client — it
# never opens a database connection — but prisma.config.ts (via `env(...)`)
# still eagerly validates that DATABASE_URL resolves to *some* string. Supply
# an inert placeholder for this build-only step; it is not a real credential,
# is never used for a connection, and does not persist into the runtime image.
ENV DATABASE_URL=postgresql://build:build@build-time-only:5432/build
RUN pnpm prisma generate && pnpm build

FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
# BackupService shells out to `pg_dump` (see src/modules/backup) — not
# available on node:24-slim by default. The db service runs postgres:18
# (see db/Dockerfile), and pg_dump generally needs to be >= the server's
# major version, which the base image's own Debian repos aren't guaranteed
# to carry yet — pull postgresql-client-18 from the official PGDG apt repo
# instead of whatever `postgresql-client` happens to resolve to, so the
# client version is pinned to match the server rather than left to chance.
# curl/gnupg/ca-certificates are build-time-only (fetching+verifying the
# PGDG signing key) and are purged again before this layer is done, so the
# final image only carries postgresql-client-18 itself.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && . /etc/os-release \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y --auto-remove curl gnupg \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Production install only: the app never imports the `prisma` CLI, ts-node,
# @nestjs/cli, etc. at runtime. Everything the running app needs
# (@prisma/adapter-pg, pg, @prisma/client-runtime-utils, nestjs-pino, helmet,
# ...) lives in "dependencies", not "devDependencies".
RUN pnpm install --frozen-lockfile --prod
# dist already contains dist/generated/prisma (copied there by `nest build`
# as a configured asset) — that's the entire Prisma client runtime this image
# needs. We deliberately do NOT copy node_modules/.prisma (this project uses
# a custom generator `output`, so nothing is ever generated under
# node_modules/.prisma) and do NOT copy the prisma/ source directory or
# prisma.config.ts (schema/migrations are a CLI-only concern — see README for
# how migrations are applied; the running app never reads prisma/schema.prisma).
COPY --from=build /app/dist ./dist
# EvidenceStorageService lazily mkdir -p's subdirectories under
# EVIDENCE_STORAGE_PATH (default ./storage/evidence, relative to /app) the
# first time a file is written — pre-create the parent here, owned by the
# non-root runtime user below, so that first write doesn't need root.
# BackupService does the same under BACKUP_DIR (default ./storage/backups).
RUN mkdir -p /app/storage/evidence /app/storage/backups
# node:24-slim (the official Docker image) already ships a non-root `node`
# user/group (uid/gid 1000) — reused here rather than creating a new one.
# Everything under /app must be owned by it, not just storage/, since the
# process itself (node executing dist/main.js) also needs read access to
# dist/ and node_modules/ as that user.
RUN chown -R node:node /app
USER node
# Matches docker-compose.yml's PORT: 4000 (and API_HOST_PORT's default) —
# EXPOSE is documentation only and doesn't itself bind the port, but it
# should still describe the port the app actually listens on.
EXPOSE 4000
CMD ["node", "dist/main.js"]
