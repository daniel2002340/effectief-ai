import { createHmac, timingSafeEqual } from 'node:crypto';
import { errorResponseSchema } from '@effectief/shared';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_BODY_LIMIT_BYTES } from '../src/plugins/raw-body.ts';
import { createTestApp } from './helpers.ts';

const SIGNING_KEY = 'test-signing-key-not-a-secret';

function sign(body: string | Buffer): string {
  return createHmac('sha256', SIGNING_KEY).update(body).digest('hex');
}

function verify(request: FastifyRequest, rawBody: Buffer): boolean {
  const header = request.headers['x-signature'];
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(sign(rawBody));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

describe('server refuses to start', () => {
  it('when a route declares no auth type', async () => {
    await expect(
      createTestApp({}, (app) => {
        app.get('/no-auth', async () => 'open');
      }),
    ).rejects.toThrow(/GET \/no-auth: missing or unknown auth type/);
  });

  it('when a route declares an unknown auth type', async () => {
    await expect(
      createTestApp({}, (app) => {
        // @ts-expect-error: deliberately invalid
        app.get('/odd-auth', { config: { auth: 'none' } }, async () => 'open');
      }),
    ).rejects.toThrow(/missing or unknown auth type/);
  });

  it('when an auth-less route is registered inside a plugin', async () => {
    await expect(
      createTestApp({}, async (app) => {
        await app.register(async (scope) => {
          scope.post('/nested', async () => 'open');
        });
      }),
    ).rejects.toThrow(/POST \/nested/);
  });

  it('when an hmac route has no verify function', async () => {
    await expect(
      createTestApp({
        webhooks: async (scope) => {
          scope.post('/unsigned', { config: { auth: 'hmac' } }, async () => 'ok');
        },
      }),
    ).rejects.toThrow(/requires config.hmac.verify/);
  });

  it('when an hmac route is registered outside the webhook scope', async () => {
    await expect(
      createTestApp({}, (app) => {
        app.post(
          '/stray-webhook',
          { config: { auth: 'hmac', hmac: { verify } } },
          async () => 'ok',
        );
      }),
    ).rejects.toThrow(/only allowed via registerWebhookRoutes/);
  });
});

describe('auth types at runtime', () => {
  it('denies session routes while there is no session', async () => {
    const app = await createTestApp({}, (instance) => {
      instance.get('/me', { config: { auth: 'session' } }, async () => ({ secret: true }));
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/me' });
      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
    } finally {
      await app.close();
    }
  });

  it('verifies hmac signatures on the exact raw body', async () => {
    let received: Buffer | undefined;
    const app = await createTestApp({
      webhooks: async (scope) => {
        scope.post('/test', { config: { auth: 'hmac', hmac: { verify } } }, async (request) => {
          received = request.body as Buffer;
          return { received: true };
        });
      },
    });
    try {
      // Whitespace and key order matter for signatures; a re-serialised body would not match.
      const payload = '{ "b": 1,   "a": "é" }';

      const ok = await app.inject({
        method: 'POST',
        url: '/webhooks/test',
        headers: { 'content-type': 'application/json', 'x-signature': sign(payload) },
        payload,
      });
      expect(ok.statusCode).toBe(200);
      expect(received?.toString('utf8')).toBe(payload);

      const forged = await app.inject({
        method: 'POST',
        url: '/webhooks/test',
        headers: { 'content-type': 'application/json', 'x-signature': sign('{}') },
        payload,
      });
      expect(forged.statusCode).toBe(401);
      expect(errorResponseSchema.parse(forged.json()).error.code).toBe('UNAUTHORIZED');

      const unsigned = await app.inject({
        method: 'POST',
        url: '/webhooks/test',
        headers: { 'content-type': 'text/plain' },
        payload,
      });
      expect(unsigned.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('answers unknown webhook paths with 401, not 404', async () => {
    const app = await createTestApp();
    try {
      for (const url of ['/webhooks', '/webhooks/', '/webhooks/unknown', '/webhooks/a/b']) {
        const response = await app.inject({ method: 'POST', url, payload: '{}' });
        expect(response.statusCode, url).toBe(401);
        expect(errorResponseSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
      }
      // Outside the scope a normal 404 remains.
      expect((await app.inject({ method: 'GET', url: '/webhookz' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('enforces its own body limit on webhooks', async () => {
    const app = await createTestApp({
      webhooks: async (scope) => {
        scope.post('/big', { config: { auth: 'hmac', hmac: { verify } } }, async () => 'ok');
      },
    });
    try {
      const payload = Buffer.alloc(WEBHOOK_BODY_LIMIT_BYTES + 1, 'a');
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/big',
        headers: { 'content-type': 'application/octet-stream', 'x-signature': sign(payload) },
        payload,
      });
      expect(response.statusCode).toBe(413);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
    } finally {
      await app.close();
    }
  });
});
