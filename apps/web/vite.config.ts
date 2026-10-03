import { fileURLToPath } from 'node:url';
import { parseEnv } from '@effectief/shared';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { webDevEnvSchema, webEnvSchema } from './src/env.ts';

const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ command, mode }) => {
  // Fail the build (and the dev server) when a variable is missing or invalid.
  const env = parseEnv(webEnvSchema, { ...loadEnv(mode, envDir, 'VITE_'), ...pickVite() });
  const devEnv =
    command === 'serve' && mode !== 'production'
      ? parseEnv(webDevEnvSchema, { ...loadEnv(mode, envDir, ''), ...process.env })
      : undefined;

  return {
    envDir,
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5180,
      strictPort: true,
      proxy: devEnv ? { [env.VITE_API_BASE_PATH]: devEnv.WEB_DEV_API_TARGET } : {},
    },
    preview: { port: 4180, strictPort: true },
  };
});

/** VITE_* variables from the process environment win over .env files, as in Vite itself. */
function pickVite(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')));
}
