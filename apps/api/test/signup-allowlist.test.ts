import { randomUUID } from 'node:crypto';
import { sql } from '@effectief/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authDatabase, createTestApp, testEnv } from './helpers.ts';

const json = { 'content-type': 'application/json', origin: testEnv.APP_ORIGIN };
const runId = randomUUID();
const allowedEmail = `toegestaan-${runId}@toegestaan.test`;
const refusedEmail = `geweigerd-${runId}@example.test`;

let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp({
    env: {
      AUTH_SIGNUP_ALLOWLIST: { anyone: false, emails: [], domains: ['toegestaan.test'] },
    },
    loginRateLimit: { max: 1000, timeWindow: '1 minute' },
  });
});

afterAll(async () => {
  await app.close();
  await authDatabase.db.execute(
    sql`delete from "user" where email in (${allowedEmail}, ${refusedEmail})`,
  );
});

function signUp(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: json,
    payload: { name: 'Test Gebruiker', email, password: 'een-lang-wachtwoord' },
  });
}

describe('sign-up allowlist (decision #062)', () => {
  it('creates an account for an allowed domain', async () => {
    const response = await signUp(allowedEmail);
    expect(response.statusCode).toBe(200);
  });

  it('refuses an address outside the allowlist and creates no user', async () => {
    const response = await signUp(refusedEmail);
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('toegestaan.test');

    const rows = await authDatabase.db.execute(
      sql`select 1 from "user" where email = ${refusedEmail}`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('cannot be bypassed with different casing or whitespace on the domain', async () => {
    const response = await signUp(`ANDER-${runId}@Example.TEST`);
    expect(response.statusCode).toBe(403);
  });
});
