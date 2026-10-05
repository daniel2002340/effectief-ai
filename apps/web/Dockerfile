# syntax=docker/dockerfile:1
# The edge image (decision #057): the built web app plus Caddy, which also
# forwards /api, /webhooks and /health to the api. Build from the repository root:
#   docker build -f apps/web/Dockerfile \
#     --build-arg VITE_API_BASE_PATH=/api --build-arg VITE_SENTRY_DSN=disabled \
#     --build-arg VITE_SENTRY_ENVIRONMENT=development --build-arg VITE_APP_RELEASE=dev .
FROM node:24.21.0-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline --ignore-scripts
# Required; vite.config.ts fails the build when one is missing or invalid.
ARG VITE_API_BASE_PATH
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_ENVIRONMENT
ARG VITE_APP_RELEASE
ENV VITE_API_BASE_PATH=$VITE_API_BASE_PATH \
    VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT \
    VITE_APP_RELEASE=$VITE_APP_RELEASE
RUN pnpm --filter @effectief/web build
# Source maps to Sentry, then out of the image (decision #055). See apps/api/Dockerfile.
ARG SENTRY_UPLOAD=false
ARG SENTRY_URL
ARG SENTRY_ORG
ARG SENTRY_PROJECT
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  if [ "$SENTRY_UPLOAD" = true ]; then \
    SOURCEMAPS_DIR=apps/web/dist APP_RELEASE="$VITE_APP_RELEASE" pnpm sourcemaps:upload; \
  elif [ "$SENTRY_UPLOAD" != false ]; then \
    echo "SENTRY_UPLOAD must be true or false" >&2; exit 1; \
  fi
RUN find apps/web/dist -name '*.map' -delete \
  && if grep -rl 'sourceMappingURL' apps/web/dist; then echo "bundle points to a source map" >&2; exit 1; fi

FROM caddy:2.11.6-alpine
# Caddy writes nothing with admin, autosave and automatic HTTPS off; these
# directories only keep it from touching / as a non-root user.
ENV XDG_DATA_HOME=/tmp/caddy/data XDG_CONFIG_HOME=/tmp/caddy/config
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY apps/web/edge-entrypoint.sh /usr/local/bin/edge-entrypoint
# Pre-deploy on the host: edge-wait-for-api (decision #064)
COPY apps/web/edge-wait-for-api.sh /usr/local/bin/edge-wait-for-api
COPY --from=build /repo/apps/web/dist /srv
# Same release as the bundle; the pre-deploy waits for an api with this release.
ARG VITE_APP_RELEASE
ENV APP_RELEASE=$VITE_APP_RELEASE
USER nobody
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/edge-entrypoint"]
