#!/usr/bin/env sh
# Assembles a runnable app: its bundled dist/ plus production node_modules.
# Used by the Dockerfiles and by the CI smoke test, so both run the same artifact.
#
#   scripts/deploy-app.sh <api|worker> <target-dir>   (after install and `pnpm build`)
#
# inject-workspace-packages only for this command: pnpm 10 then deploys from
#   the shared lockfile (exact versions, offline). Enabling it for the whole
#   workspace would put workspace packages under node_modules, where Node
#   refuses to run their TypeScript source in dev.
# node-linker=hoisted: the bundle imports dependencies of workspace packages
#   (e.g. pg via @effectief/db), so they must sit in the top-level node_modules.
set -eu

app="$1"
target="$2"

pnpm --filter "@effectief/${app}" deploy --prod --offline --ignore-scripts \
  --config.inject-workspace-packages=true \
  --config.node-linker=hoisted \
  "$target"
