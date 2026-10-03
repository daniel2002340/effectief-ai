import { createHmac } from 'node:crypto';
import { errorResponseSchema } from '@effectief/shared';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { trustProxySchema } from '../src/env.ts';
import { createTestApp } from './helpers.ts';

const SIGNING_KEY = 'test-signing-key-not-a-secret';
const sign = (body: string) => createHmac('sha256', SIGNING_KEY).update(body).digest('hex');

const signedWebhook = async (scope: import('fastify').FastifyInstance) => {
  scope.post(
    '/signed',
    {
      config: {
        auth: 'hmac',
        hmac: { verify: (request, raw) => request.headers['x-signature'] === sign(raw.toString()) },
      },
    },
    async () => ({ ok: true }),
  );
};

describe('API_TRUST_PROXY', () => {
  it.each([
    ['false', false],
    ['2', 2],
    ['10.0.0.0/8, 192.168.1.1', ['10.0.0.0/8', '192.168.1.1']],
  ])('parses %j', (input, expected) => {
    expect(trustProxySchema.parse(input)).toEqual(expected);
  });

  it.each(['true', '', 'proxy.local', '10.0.0.0/8,nope'])('rejects %j', (input) => {
    expect(trustProxySchema.safeParse(input).success).toBe(false);
  });
});

describe('rate limit exemptions', () => {
  it('never limits /health', async () => {
    const app = await createTestApp({ rateLimitMax: 1 });
    try {
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['x-ratelimit-limit']).toBeUndefined();
      }
    } finally {
      await app.close();
    }
  });

  it('never limits signed webhook routes', async () => {
    const app = await createTestApp({ rateLimitMax: 1, webhooks: signedWebhook });
    try {
      for (let i = 0; i < 3; i++) {
        const payload = `{"n":${i}}`;
        const response = await app.inject({
          method: 'POST',
          url: '/webhooks/signed',
          headers: { 'content-type': 'application/json', 'x-signature': sign(payload) },
          payload,
        });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('still limits other routes', async () => {
    const app = await createTestApp({ rateLimitMax: 1 });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/system/status' })).statusCode).toBe(200);
      const limited = await app.inject({ method: 'GET', url: '/api/system/status' });
      expect(limited.statusCode).toBe(429);
      expect(errorResponseSchema.parse(limited.json()).error.code).toBe('RATE_LIMITED');
    } finally {
      await app.close();
    }
  });
});

describe('client IP behind a proxy', () => {
  const request = (forwardedFor: string) => ({
    method: 'GET' as const,
    url: '/api/system/status',
    headers: { 'x-forwarded-for': forwardedFor },
  });

  it('uses X-Forwarded-For when the proxy is trusted', async () => {
    const app = await createTestApp({ rateLimitMax: 1, env: { API_TRUST_PROXY: 1 } });
    try {
      expect((await app.inject(request('203.0.113.1'))).statusCode).toBe(200);
      expect((await app.inject(request('203.0.113.2'))).statusCode).toBe(200);
      expect((await app.inject(request('203.0.113.1'))).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('ignores X-Forwarded-For when no proxy is trusted', async () => {
    const app = await createTestApp({ rateLimitMax: 1, env: { API_TRUST_PROXY: false } });
    try {
      expect((await app.inject(request('203.0.113.1'))).statusCode).toBe(200);
      expect((await app.inject(request('203.0.113.2'))).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});

describe('without Valkey', () => {
  it('keeps /health up and refuses limited requests', async () => {
    // Nothing listens on port 1; same client options as main.ts.
    const unreachable = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    unreachable.on('error', () => {});
    const app = await createTestApp({ redis: unreachable, webhooks: signedWebhook });
    try {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: 'ok' });

      const limited = await app.inject({ method: 'GET', url: '/api/system/status' });
      expect(limited.statusCode).toBe(500);
      expect(errorResponseSchema.parse(limited.json()).error.code).toBe('INTERNAL_ERROR');

      const payload = '{}';
      const webhook = await app.inject({
        method: 'POST',
        url: '/webhooks/signed',
        headers: { 'content-type': 'application/json', 'x-signature': sign(payload) },
        payload,
      });
      expect(webhook.statusCode).toBe(200);
    } finally {
      await app.close();
      unreachable.disconnect();
    }
  });
});
