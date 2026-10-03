# Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg VITE_API_BASE_PATH=/api .
FROM node:24.21.0-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline --ignore-scripts
# Required; vite.config.ts fails the build when it is missing or invalid.
ARG VITE_API_BASE_PATH
ENV VITE_API_BASE_PATH=$VITE_API_BASE_PATH
RUN pnpm --filter @effectief/web build

# Static files only; /api and /webhooks are routed to the api by the reverse proxy (decision #021).
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
