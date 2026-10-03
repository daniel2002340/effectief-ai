import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root .env for local runs; CI sets the variables directly.
    env: loadEnv('test', new URL('../..', import.meta.url).pathname, ''),
    // Test files share rate-limit counters in Valkey.
    fileParallelism: false,
  },
});
