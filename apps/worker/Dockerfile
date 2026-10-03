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

# Runtime: Node and one bundled file, no node_modules (decision #019).
FROM node:24.21.0-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN echo '{"type":"module"}' > package.json
COPY --from=build /repo/apps/worker/dist ./dist
USER node

CMD ["node", "--enable-source-maps", "dist/main.js"]
