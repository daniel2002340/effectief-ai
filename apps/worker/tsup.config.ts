import { defineConfig } from 'tsup';

/**
 * Bundles the worker into a single ESM artifact that runs with plain `node`,
 * without node_modules. Some dependencies are CommonJS and call require(),
 * hence the createRequire banner.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
