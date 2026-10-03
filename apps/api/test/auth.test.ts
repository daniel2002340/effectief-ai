import { randomUUID } from 'node:crypto';
import { sql } from '@effectief/db';
import { errorResponseSchema } from '@effectief/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authDatabase, createTestApp, testEnv } from './helpers.ts';

const origin = testEnv.APP_ORIGIN;
const json = { 'content-type': 'application/json', origin };
const password = 'een-lang-wachtwoord';
const createdUsers: string[] = [];
const createdTenants: string[] = [];

/** Signs up a user, creates their company and returns the session cookie. */
async function registerTenant(app: FastifyInstance, company: string) {
  const email = `test-${randomUUID()}@example.test`;
  const signUp = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: json,
    payload: { name: 'Test Gebruiker', email, password },
  });
  expect(signUp.statusCode).toBe(200);
  createdUsers.push(signUp.json().user.id);
  // Creating the organization makes it the session's active tenant.
  const cookie = sessionCookie(signUp.headers['set-cookie']);

  const created = await app.inject({
    method: 'POST',
    url: '/api/auth/organization/create',
    headers: { ...json, cookie },
    payload: { name: company, slug: `test-${randomUUID()}` },
  });
  expect(created.statusCode).toBe(200);
  const tenantId: string = created.json().id;
  createdTenants.push(tenantId);
  return { email, cookie, tenantId };
}

function sessionCookie(header: string | string[] | undefined): string {
  const cookies = Array.isArray(header) ? header : header ? [header] : [];
  const session = cookies.find((value) => value.includes('session_token='));
  return session?.split(';')[0] ?? '';
}

let app: FastifyInstance;
let a: Awaited<ReturnType<typeof registerTenant>>;
let b: Awaited<ReturnType<typeof registerTenant>>;

beforeAll(async () => {
  app = await createTestApp({ loginRateLimit: { max: 1000, timeWindow: '1 minute' } });
  a = await registerTenant(app, 'Installatiebedrijf A');
  b = await registerTenant(app, 'Hoveniersbedrijf B');
});

afterAll(async () => {
  await app.close();
  // Cascades to members, sessions, accounts and tenant_settings.
  await authDatabase.db.execute(
    sql`delete from organization where id in ${sql.raw(`('${createdTenants.join("','")}')`)}`,
  );
  await authDatabase.db.execute(
    sql`delete from "user" where id in ${sql.raw(`('${createdUsers.join("','")}')`)}`,
  );
});

describe('session cookie', () => {
  it('is httpOnly and SameSite=Strict', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: json,
      payload: { email: a.email, password },
    });
    expect(response.statusCode).toBe(200);
    const cookie = [response.headers['set-cookie']]
      .flat()
      .find((c) => c?.includes('session_token'));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('a fresh sign-in starts in the user’s tenant', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: json,
      payload: { email: b.email, password },
    });
    const cookie = sessionCookie(signIn.headers['set-cookie']);
    const response = await app.inject({ method: 'GET', url: '/api/tenant', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Hoveniersbedrijf B');
  });

  it('refuses a wrong password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: json,
      payload: { email: a.email, password: 'verkeerd-wachtwoord' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('tenant.current', () => {
  it('answers 401 without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tenant' });
    expect(response.statusCode).toBe(401);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('answers 401 with a forged cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tenant',
      headers: { cookie: 'better-auth.session_token=forged.value' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns only the session’s own tenant', async () => {
    const responseA = await app.inject({
      method: 'GET',
      url: '/api/tenant',
      headers: { cookie: a.cookie },
    });
    const responseB = await app.inject({
      method: 'GET',
      url: '/api/tenant',
      headers: { cookie: b.cookie },
    });
    expect(responseA.statusCode).toBe(200);
    expect(responseA.json()).toEqual({ name: 'Installatiebedrijf A', defaultVatRateBps: 2100 });
    expect(responseB.json()).toEqual({ name: 'Hoveniersbedrijf B', defaultVatRateBps: 2100 });
  });

  it('ignores a tenant id in the query string', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/tenant?tenantId=${b.tenantId}`,
      headers: { cookie: a.cookie },
    });
    expect(response.json().name).toBe('Installatiebedrijf A');
  });

  it('answers 401 once the user is no longer a member of the active tenant', async () => {
    const c = await registerTenant(app, 'Schoonmaakbedrijf C');
    await authDatabase.db.execute(sql`delete from member where organization_id = ${c.tenantId}`);
    const response = await app.inject({
      method: 'GET',
      url: '/api/tenant',
      headers: { cookie: c.cookie },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('tenant.updateSettings', () => {
  it('changes only the session’s tenant, whatever tenant id the body names', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tenant/settings',
      headers: { ...json, cookie: a.cookie },
      payload: { defaultVatRateBps: 900, tenantId: b.tenantId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().defaultVatRateBps).toBe(900);

    const other = await app.inject({
      method: 'GET',
      url: '/api/tenant',
      headers: { cookie: b.cookie },
    });
    expect(other.json().defaultVatRateBps).toBe(2100);
  });

  it('answers 401 without a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tenant/settings',
      headers: json,
      payload: { defaultVatRateBps: 0 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('validates the input', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/tenant/settings',
      headers: { ...json, cookie: a.cookie },
      payload: { defaultVatRateBps: 1900 },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error.code).toBe('VALIDATION_FAILED');
  });
});

describe('CSRF: changes only via POST with JSON', () => {
  const nonJson = [
    ['an HTML form', 'application/x-www-form-urlencoded', 'defaultVatRateBps=0'],
    ['a multipart form', 'multipart/form-data; boundary=x', '--x--'],
    ['text/plain', 'text/plain', '{"defaultVatRateBps":0}'],
  ] as const;

  it.each(nonJson)('refuses %s with 415', async (_name, contentType, payload) => {
    for (const url of ['/api/tenant/settings', '/api/auth/sign-in/email', '/api/auth/sign-out']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': contentType, origin, cookie: a.cookie },
        payload,
      });
      expect(response.statusCode, url).toBe(415);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('refuses a POST without body or content type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { origin, cookie: a.cookie },
    });
    expect(response.statusCode).toBe(415);
  });

  it('does not run a POST procedure for a GET', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/tenant/settings?defaultVatRateBps=0',
      headers: { cookie: a.cookie },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const current = await app.inject({
      method: 'GET',
      url: '/api/tenant',
      headers: { cookie: a.cookie },
    });
    expect(current.json().defaultVatRateBps).not.toBe(0);
  });

  it('Better Auth refuses a cookie-carrying request from a foreign origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/organization/create',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        cookie: a.cookie,
      },
      payload: { name: 'Overgenomen', slug: `test-${randomUUID()}` },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('login rate limit', () => {
  it('is stricter on sign-in than the global limit', async () => {
    const limited = await createTestApp({
      rateLimitMax: 100,
      loginRateLimit: { max: 3, timeWindow: '15 minutes' },
    });
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: json,
          payload: { email: a.email, password: 'verkeerd-wachtwoord' },
        });
      for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(errorResponseSchema.parse(blocked.json()).error.code).toBe('RATE_LIMITED');

      // Other routes still use the global limit.
      const status = await limited.inject({ method: 'GET', url: '/api/system/status' });
      expect(status.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('applies to sign-up as well', async () => {
    const limited = await createTestApp({ loginRateLimit: { max: 1, timeWindow: '15 minutes' } });
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/api/auth/sign-up/email',
          headers: json,
          payload: { name: 'x', email: 'not-an-email', password },
        });
      expect((await attempt()).statusCode).toBe(400);
      expect((await attempt()).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
