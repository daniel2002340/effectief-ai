// Makes the local api's /webhooks/* reachable for providers through a
// cloudflared quick tunnel (README, decision #071). Development only: refuses
// to run in CI or production, and scripts/dev is not in any image.
//
//   pnpm dev            (api on API_HOST:API_PORT)
//   pnpm tunnel         prints https://<random>.trycloudflare.com
//
// The URL changes on every start. A provider that needs a fixed URL gets a
// named tunnel when that comes up (docs/todo.md).
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createWebhookProxy } from './webhook-proxy.ts';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.env.CI || process.env.NODE_ENV === 'production') {
  fail('The webhook tunnel is for local development only.');
}
const host = process.env.API_HOST;
const port = Number(process.env.API_PORT);
if (!host || !Number.isInteger(port) || port <= 0) {
  fail('API_HOST and API_PORT must be set (see .env.example).');
}
if (process.env.API_TRUST_PROXY !== '1') {
  process.stderr.write(
    'Note: API_TRUST_PROXY is not 1, so the api sees every tunnel request as 127.0.0.1 (README, #071).\n',
  );
}

const proxy = createWebhookProxy({ host, port });
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = (proxy.address() as AddressInfo).port;

const tunnel = spawn(
  'cloudflared',
  ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${proxyPort}`],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
tunnel.on('error', () =>
  fail('cloudflared not found; install it with `brew install cloudflared`.'),
);

let announced = false;
tunnel.stderr.setEncoding('utf8');
tunnel.stderr.on('data', (chunk: string) => {
  const url = chunk.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (url && !announced) {
    announced = true;
    process.stdout.write(
      `Webhooks reachable at ${url}/webhooks/<provider>\nOnly /webhooks/* is forwarded to http://${host}:${port}. Ctrl+C stops the tunnel.\n`,
    );
  }
});

const stop = () => {
  tunnel.kill('SIGTERM');
  proxy.close();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.on('exit', (code) => {
  proxy.close();
  process.exit(code ?? 0);
});
