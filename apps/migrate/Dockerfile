# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/migrate/Dockerfile --build-arg APP_RELEASE=$(git rev-parse HEAD) .
FROM node:24.21.0-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
# Scripts are skipped: no git hooks in the image, and the build needs no postinstall.
RUN pnpm install --frozen-lockfile --offline --ignore-scripts
RUN pnpm --filter @effectief/migrate build
ARG APP_RELEASE
# Bundle plus production node_modules, the same way the CI smoke test does it (decision #028).
RUN scripts/deploy-app.sh migrate /out

# The verify job (decision #065): the RLS and role tests of packages/db against
# a deployed database, as the app and auth roles only. Needs the sources and
# vitest, so it is the workspace itself, not a bundle. Build with --target verify.
FROM node:24.21.0-alpine AS verify
ENV NODE_ENV=test
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/packages/db
USER node
# Pre-deploy on the host: node scripts/wait-for-schema.ts
CMD ["node_modules/.bin/vitest", "run", "--config", "vitest.verify.config.ts"]

# The migration job; the default target.
FROM node:24.21.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Release name for the logs of a deploy.
ARG APP_RELEASE
ENV APP_RELEASE=$APP_RELEASE
USER node
COPY packages/db/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations
# Pre-deploy on the host runs the migrations: node dist/main.js. The start
# command only reports and exits, so the owner credentials are not kept in a
# running process (decision #058).
CMD ["node", "--enable-source-maps", "dist/status.js"]
