import { sql } from '@effectief/db';
import { MonitoringTestError, monitoringTestData } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authDatabase,
  createTestApp,
  enqueuedMonitoringTests,
  registerTenant,
  removeRegisteredTenants,
  reportedErrors,
} from './helpers.ts';

// The test errors of decision #069: POST /api/test/error, only outside
// production and only for an owner.

const json = { 'content-type': 'application/json' };
const call = (app: FastifyInstance, cookie: string | undefined, target: string) =>
  app.inject({
    method: 'POST',
    url: '/api/test/error',
    headers: cookie ? { ...json, cookie } : json,
    payload: { target },
  });

let app: FastifyInstance;
let production: FastifyInstance;
beforeAll(async () => {
  app = await createTestApp({ env: { SENTRY_ENVIRONMENT: 'staging' } });
  production = await createTestApp({ env: { SENTRY_ENVIRONMENT: 'production' } });
});
afterAll(async () => {
  await Promise.all([app.close(), production.close()]);
  await removeRegisteredTenants();
});
beforeEach(() => {
  reportedErrors.length = 0;
  enqueuedMonitoringTests.length = 0;
});

describe('test errors outside production', () => {
  it('throws for an owner: 500 without details, reported with the original error', async () => {
    const owner = await registerTenant(app, 'Testfout BV');
    const response = await call(app, owner.cookie, 'api');

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain(monitoringTestData.email);
    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0]?.error).toBeInstanceOf(MonitoringTestError);
    expect(reportedErrors[0]?.context).toEqual({
      requestId: response.headers['x-request-id'],
      route: '/api/test/error',
    });
  });

  it('queues the failing worker job with the tenant of the session only', async () => {
    const owner = await registerTenant(app, 'Testfout Worker BV');
    const response = await call(app, owner.cookie, 'worker');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'queued' });
    expect(enqueuedMonitoringTests).toEqual([{ tenantId: owner.tenantId }]);
  });

  it('refuses a member (403) and a request without a session (401)', async () => {
    const member = await registerTenant(app, 'Testfout Lid BV');
    await authDatabase.db.execute(
      sql`update member set role = 'member' where organization_id = ${member.tenantId}`,
    );

    for (const target of ['api', 'worker']) {
      expect((await call(app, member.cookie, target)).statusCode).toBe(403);
      expect((await call(app, undefined, target)).statusCode).toBe(401);
    }
    expect(reportedErrors).toEqual([]);
    expect(enqueuedMonitoringTests).toEqual([]);
  });
});

describe('test errors in production', () => {
  it('do not exist: 404 for an owner, nothing thrown or queued', async () => {
    const owner = await registerTenant(production, 'Productie BV');
    for (const target of ['api', 'worker']) {
      const response = await call(production, owner.cookie, target);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
    expect(reportedErrors).toEqual([]);
    expect(enqueuedMonitoringTests).toEqual([]);
  });
});
