import { errorResponseSchema } from '@effectief/shared';
import { oc } from '@orpc/contract';
import { call, ORPCError } from '@orpc/server';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBuilders } from '../src/orpc/builders.ts';
import { createTestApp } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());

describe('oRPC contract routes', () => {
  it('serves public procedures', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers unknown procedures with the standard 404 shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });
});

describe('procedure builders', () => {
  const testContract = {
    secret: oc.route({ method: 'GET', path: '/secret' }).output(z.string()),
    open: oc.route({ method: 'GET', path: '/open' }).output(z.string()),
  };
  const sessions = new Map([['let-me-in', { userId: 'user-1', tenantId: 'tenant-1' }]]);
  const { procedure, publicProcedure, router } = createBuilders(
    testContract,
    async (headers) => sessions.get(headers.get('cookie') ?? '') ?? null,
  );
  const testRouter = router({
    secret: procedure.secret.handler(({ context }) => `secret for ${context.session.tenantId}`),
    open: publicProcedure.open.handler(() => 'open'),
  });
  const context = (cookie?: string) => ({
    requestId: 'test',
    log: pino({ level: 'silent' }),
    headers: new Headers(cookie ? { cookie } : {}),
  });

  it('requires a session by default', async () => {
    for (const cookie of [undefined, 'not-a-session']) {
      const error = await call(testRouter.secret, undefined, { context: context(cookie) }).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe('UNAUTHORIZED');
    }
  });

  it('passes the session to the handler', async () => {
    await expect(
      call(testRouter.secret, undefined, { context: context('let-me-in') }),
    ).resolves.toBe('secret for tenant-1');
  });

  it('lets publicProcedure through, also after combining into a router', async () => {
    await expect(call(testRouter.open, undefined, { context: context() })).resolves.toBe('open');
  });
});
