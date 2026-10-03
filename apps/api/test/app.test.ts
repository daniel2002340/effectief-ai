import { errorResponseSchema } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../src/errors.ts';
import { createTestApp } from './helpers.ts';

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp({}, (instance) => {
    instance.get('/test/boom', { config: { auth: 'public' } }, async () => {
      throw new Error('secret detail: db password is hunter2');
    });
    instance.get('/test/zod', { config: { auth: 'public' } }, async () => {
      z.object({ email: z.email() }).parse({ email: 'nope' });
    });
    instance.get('/test/app-error', { config: { auth: 'public' } }, async () => {
      throw new AppError('CONFLICT');
    });
    instance.post('/test/echo', { config: { auth: 'public' } }, async (request) => request.body);
  });
});
afterAll(() => app.close());

describe('GET /health', () => {
  it('returns 200 with security headers and a request id', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-ratelimit-limit']).toBeDefined();
  });
});

describe('error responses', () => {
  it('answers unknown routes with the standard 404 shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('hides details of unexpected errors', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/boom' });
    expect(response.statusCode).toBe(500);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('hunter2');
  });

  it('turns Zod errors into VALIDATION_FAILED with issues', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/zod' });
    expect(response.statusCode).toBe(400);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.issues?.[0]?.path).toEqual(['email']);
  });

  it('passes AppError code and status through', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/app-error' });
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('CONFLICT');
  });

  it('answers malformed JSON with BAD_REQUEST', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('BAD_REQUEST');
  });
});

describe('rate limiting', () => {
  it('answers with RATE_LIMITED in the standard shape', async () => {
    const limited = await createTestApp({ rateLimitMax: 2 });
    try {
      await limited.inject({ method: 'GET', url: '/health' });
      await limited.inject({ method: 'GET', url: '/health' });
      const response = await limited.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(429);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
