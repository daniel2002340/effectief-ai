import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebhookProxy, webhookPath } from '../../../scripts/dev/webhook-proxy.ts';
import { createTestApp } from './helpers.ts';

// The dev webhook tunnel (decision #071): cloudflared → webhook-proxy → api
// with API_TRUST_PROXY=1, the same hop count as Caddy on staging.

const SIGNING_KEY = 'test-signing-key-not-a-secret';
const sign = (body: string) => createHmac('sha256', SIGNING_KEY).update(body).digest('hex');

describe('webhookPath', () => {
  it.each([
    ['/webhooks/nango', '/webhooks/nango'],
    ['/webhooks/mollie?id=1', '/webhooks/mollie?id=1'],
  ])('forwards %s', (input, expected) => {
    expect(webhookPath(input)).toBe(expected);
  });

  it.each([
    '/api/auth/sign-up/email',
    '/health',
    '/webhooks',
    '/webhooks/../api/auth/sign-up/email',
    '/webhooks/%2e%2e/api/tenant',
    'http://evil.example/webhooks/x',
    undefined,
  ])('refuses %s', (input) => {
    expect(webhookPath(input)).toBeNull();
  });
});

describe('webhook tunnel proxy', () => {
  let app: FastifyInstance;
  let proxy: ReturnType<typeof createWebhookProxy>;
  let base: string;
  const seen: { ip: string }[] = [];

  beforeAll(async () => {
    app = await createTestApp({
      env: { API_TRUST_PROXY: 1 },
      webhooks: async (scope) => {
        scope.post(
          '/echo',
          {
            config: {
              auth: 'hmac',
              hmac: {
                verify: (request, raw) => request.headers['x-signature'] === sign(raw.toString()),
              },
            },
          },
          async (request) => {
            seen.push({ ip: request.ip });
            return { ok: true };
          },
        );
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const apiPort = (app.server.address() as AddressInfo).port;
    proxy = createWebhookProxy({ host: '127.0.0.1', port: apiPort });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await app.close();
  });

  it('passes a signed webhook with its raw body and the Cloudflare client IP', async () => {
    const payload = '{"b":1,  "a":"spaties blijven"}';
    const response = await fetch(`${base}/webhooks/echo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': sign(payload),
        'cf-connecting-ip': '203.0.113.7',
        // What a client sends to pick its own address; the proxy drops it.
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.2',
      },
      body: payload,
    });
    // 200 means the signature over the raw body still matched.
    expect(response.status).toBe(200);
    expect(seen.at(-1)?.ip).toBe('203.0.113.7');
  });

  it('falls back to the socket address without a Cloudflare header', async () => {
    const payload = '{}';
    await fetch(`${base}/webhooks/echo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': sign(payload),
        'x-forwarded-for': '198.51.100.1',
      },
      body: payload,
    });
    expect(seen.at(-1)?.ip).toBe('127.0.0.1');
  });

  it('does not expose the rest of the api', async () => {
    for (const path of ['/api/auth/sign-up/email', '/health', '/api/system/status']) {
      expect((await fetch(`${base}${path}`, { method: 'POST' })).status).toBe(404);
    }
  });
});
