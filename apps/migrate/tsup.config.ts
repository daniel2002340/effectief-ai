import { defineConfig } from 'tsup';

/**
 * Bundles our own code and the workspace packages (which ship TypeScript
 * source) into one ESM file. npm dependencies stay external: some load files
 * or worker threads from disk (pino transports, BullMQ). They are installed
 * next to the bundle with `pnpm deploy --prod` (decision #028).
 */
export default defineConfig({
  entry: ['src/main.ts', 'src/status.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@effectief\//],
  // Every other bare import, including dependencies of workspace packages.
  external: [/^[^./]/],
});
