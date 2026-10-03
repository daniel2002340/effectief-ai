# Build from the repository root: docker build -f apps/worker/Dockerfile .
FROM node:24.21.0-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
# Scripts are skipped: no git hooks in the image, and the build needs no postinstall.
RUN pnpm install --frozen-lockfile --offline --ignore-scripts
RUN pnpm --filter @effectief/worker build
# Bundle plus production node_modules, the same way the CI smoke test does it (decision #028).
RUN scripts/deploy-app.sh worker /out

FROM node:24.21.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
CMD ["node", "--enable-source-maps", "dist/main.js"]
