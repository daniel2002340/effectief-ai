# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/worker/Dockerfile --build-arg APP_RELEASE=$(git rev-parse HEAD) .
FROM node:24.21.0-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
# Scripts are skipped: no git hooks in the image, and the build needs no postinstall.
RUN pnpm install --frozen-lockfile --offline --ignore-scripts
RUN pnpm --filter @effectief/worker build
# Source maps to Sentry (decision #055). The deploy workflow sets SENTRY_UPLOAD=true
# and mounts the token as a secret, so it never lands in a layer. true without a
# token fails the build: a release without source maps is never shipped silently.
ARG SENTRY_UPLOAD=false
ARG SENTRY_URL
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG APP_RELEASE
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  if [ "$SENTRY_UPLOAD" = true ]; then \
    SOURCEMAPS_DIR=apps/worker/dist pnpm sourcemaps:upload; \
  elif [ "$SENTRY_UPLOAD" != false ]; then \
    echo "SENTRY_UPLOAD must be true or false" >&2; exit 1; \
  fi
# Bundle plus production node_modules, the same way the CI smoke test does it (decision #028).
RUN scripts/deploy-app.sh worker /out

FROM node:24.21.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Release name for Sentry and logs; required at startup, so a build without it does not run.
ARG APP_RELEASE
ENV APP_RELEASE=$APP_RELEASE
USER node
# Pre-deploy on the host: node dist/check-schema.js (decision #058)
CMD ["node", "--enable-source-maps", "dist/main.js"]
