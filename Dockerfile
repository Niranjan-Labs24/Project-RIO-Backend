# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
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

FROM node:24-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
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
EXPOSE 3000
CMD ["node", "dist/main.js"]
