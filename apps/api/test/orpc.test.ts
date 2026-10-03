import { contract, errorResponseSchema } from '@effectief/shared';
import { oc } from '@orpc/contract';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertContractAuth } from '../src/orpc/contract-auth.ts';
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

describe('assertContractAuth', () => {
  it('accepts the real contract', () => {
    expect(() => assertContractAuth(contract)).not.toThrow();
  });

  it('rejects a procedure without meta.auth', () => {
    const bad = { items: { list: oc.route({ method: 'GET', path: '/items' }) } };
    expect(() => assertContractAuth(bad)).toThrow(/items\.list: missing or unknown meta.auth/);
  });

  it('rejects hmac on a contract procedure', () => {
    const bad = { hook: oc.$meta({ auth: 'hmac' }).route({ method: 'POST', path: '/hook' }) };
    expect(() => assertContractAuth(bad)).toThrow(/hook/);
  });
});
