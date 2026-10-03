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
  const { procedure, publicProcedure, router } = createBuilders(testContract);
  const testRouter = router({
    secret: procedure.secret.handler(() => 'secret'),
    open: publicProcedure.open.handler(() => 'open'),
  });
  const context = { requestId: 'test', log: pino({ level: 'silent' }) };

  it('requires a session by default', async () => {
    const error = await call(testRouter.secret, undefined, { context }).catch((e) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe('UNAUTHORIZED');
  });

  it('lets publicProcedure through, also after combining into a router', async () => {
    await expect(call(testRouter.open, undefined, { context })).resolves.toBe('open');
  });
});
