import { createHash } from 'node:crypto';
import {
  isHandledNangoWebhook,
  nangoWebhookSchema,
  parseEnv,
  storedNangoWebhookSchema,
} from '@effectief/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { externalAccountIdOf } from './account.ts';
import { createNangoClient, NangoApiError } from './client.ts';
import { nangoDeliveryId } from './delivery.ts';
import { nangoEnvSchema, requireNangoEnvironment } from './env.ts';
import { nangoWebhookFixtures as fixtures } from './fixtures.ts';
import { signNangoBody, verifyNangoSignature } from './signature.ts';

const signingKey = 'test-signing-key-not-a-real-one';

describe('verifyNangoSignature', () => {
  const body = Buffer.from(JSON.stringify(fixtures.syncSuccess));

  it('accepts the HMAC-SHA256 of the exact bytes', () => {
    expect(verifyNangoSignature(body, signNangoBody(body, signingKey), signingKey)).toBe(true);
  });

  it('refuses a missing, malformed or wrong signature', () => {
    expect(verifyNangoSignature(body, undefined, signingKey)).toBe(false);
    expect(verifyNangoSignature(body, ['a', 'b'], signingKey)).toBe(false);
    expect(verifyNangoSignature(body, 'not-hex', signingKey)).toBe(false);
    expect(verifyNangoSignature(body, signNangoBody(body, 'another-key'), signingKey)).toBe(false);
  });

  it('refuses a body changed after signing, even by one byte', () => {
    const signature = signNangoBody(body, signingKey);
    const changed = Buffer.from(body.toString().replace('"added":2', '"added":3'));
    expect(verifyNangoSignature(changed, signature, signingKey)).toBe(false);
  });
});

describe('Nango webhook schemas', () => {
  it('parses every auth operation and sync result', () => {
    for (const body of [
      fixtures.authCreation,
      fixtures.authOverride,
      fixtures.authRefreshFailed,
      fixtures.authRefreshRecovered,
      fixtures.authDeletion,
      fixtures.syncSuccess,
      fixtures.syncFailed,
    ]) {
      expect(isHandledNangoWebhook(body)).toBe(true);
      expect(nangoWebhookSchema.safeParse(body).success).toBe(true);
    }
  });

  it('ignores types it does not handle', () => {
    expect(isHandledNangoWebhook(fixtures.forward)).toBe(false);
    expect(isHandledNangoWebhook({ ...fixtures.authCreation, operation: 'something_new' })).toBe(
      false,
    );
    expect(isHandledNangoWebhook('not an object')).toBe(false);
  });

  it('keeps no provider text, email or nonce in what is stored', () => {
    const parsed = nangoWebhookSchema.parse({
      ...fixtures.authRefreshFailed,
      tags: { ...fixtures.authRefreshFailed.tags, end_user_email: 'jan@example.com' },
    });
    const stored = storedNangoWebhookSchema.parse(parsed);
    const text = JSON.stringify(stored);
    expect(text).not.toContain('Provider text');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain(fixtures.ids.nonce);
    expect(stored).toMatchObject({ error: { type: 'refresh_token_external_error' } });
  });

  it('turns an odd error type into a code', () => {
    const parsed = nangoWebhookSchema.parse({
      ...fixtures.syncFailed,
      error: { type: 'some error: with spaces' },
    });
    expect(parsed.error?.type).toBe('some_error:_with_spaces');
  });

  it('refuses a body without the IDs it needs', () => {
    const { connectionId: _, ...withoutConnection } = fixtures.syncSuccess;
    expect(nangoWebhookSchema.safeParse(withoutConnection).success).toBe(false);
  });
});

describe('nangoDeliveryId', () => {
  const sync = nangoWebhookSchema.parse(fixtures.syncSuccess);
  const auth = nangoWebhookSchema.parse(fixtures.authRefreshFailed);
  const body = Buffer.from('{"same":"body"}');

  it('is the same for a retry of the same sync webhook', () => {
    const first = nangoDeliveryId(body, sync, new Date('2026-10-05T10:00:00Z'));
    const days = nangoDeliveryId(body, sync, new Date('2026-10-09T10:00:00Z'));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(days).toBe(first);
  });

  it('differs for the same auth body in another hour, so a later failure is processed', () => {
    const first = nangoDeliveryId(body, auth, new Date('2026-10-05T10:00:00.100Z'));
    const retry = nangoDeliveryId(body, auth, new Date('2026-10-05T10:00:00.900Z'));
    const later = nangoDeliveryId(body, auth, new Date('2026-10-26T10:00:00Z'));
    expect(retry).toBe(first);
    expect(later).not.toBe(first);
  });
});

describe('Nango env', () => {
  const schema = nangoEnvSchema
    .extend({ SENTRY_ENVIRONMENT: z.string() })
    .superRefine(requireNangoEnvironment());
  const valid = {
    NANGO_ENVIRONMENT: 'staging',
    NANGO_SECRET_KEY: '00000000-0000-0000-0000-000000000000',
    NANGO_WEBHOOK_SIGNING_KEY: '00000000-0000-0000-0000-000000000000',
    NANGO_WEBHOOK_URL_OVERRIDE: 'none',
    SENTRY_ENVIRONMENT: 'development',
  };

  it('accepts staging locally, with or without a tunnel override', () => {
    expect(parseEnv(schema, valid).NANGO_ENVIRONMENT).toBe('staging');
    expect(
      parseEnv(schema, {
        ...valid,
        NANGO_WEBHOOK_URL_OVERRIDE: 'https://abc.trycloudflare.com/webhooks/nango',
      }).NANGO_WEBHOOK_URL_OVERRIDE,
    ).toBe('https://abc.trycloudflare.com/webhooks/nango');
  });

  it('refuses missing or empty keys', () => {
    expect(() => parseEnv(schema, { ...valid, NANGO_SECRET_KEY: '' })).toThrow(/NANGO_SECRET_KEY/);
    expect(() => parseEnv(schema, { ...valid, NANGO_WEBHOOK_SIGNING_KEY: undefined })).toThrow(
      /NANGO_WEBHOOK_SIGNING_KEY/,
    );
  });

  it('pairs prod with production only', () => {
    expect(() => parseEnv(schema, { ...valid, NANGO_ENVIRONMENT: 'prod' })).toThrow(
      /NANGO_ENVIRONMENT/,
    );
    expect(() => parseEnv(schema, { ...valid, SENTRY_ENVIRONMENT: 'production' })).toThrow(
      /NANGO_ENVIRONMENT/,
    );
    expect(
      parseEnv(schema, { ...valid, NANGO_ENVIRONMENT: 'prod', SENTRY_ENVIRONMENT: 'production' })
        .NANGO_ENVIRONMENT,
    ).toBe('prod');
  });

  it('refuses an override on staging and production, and one that is not ours', () => {
    expect(() =>
      parseEnv(schema, {
        ...valid,
        SENTRY_ENVIRONMENT: 'staging',
        NANGO_WEBHOOK_URL_OVERRIDE: 'https://abc.trycloudflare.com/webhooks/nango',
      }),
    ).toThrow(/NANGO_WEBHOOK_URL_OVERRIDE/);
    for (const url of ['http://abc.trycloudflare.com/webhooks/nango', 'https://abc.example/x']) {
      expect(() => parseEnv(schema, { ...valid, NANGO_WEBHOOK_URL_OVERRIDE: url })).toThrow(
        /NANGO_WEBHOOK_URL_OVERRIDE/,
      );
    }
  });
});

describe('Nango client', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond =
    (status: number, body: unknown): typeof fetch =>
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status });
    };
  const client = (fetchImpl: typeof fetch) =>
    createNangoClient({ secretKey: 'key-not-a-real-one', fetch: fetchImpl });

  it('creates a connect session with our tags for one integration', async () => {
    calls.length = 0;
    const session = await client(
      respond(201, { data: { token: 'tok', expires_at: '2026-10-05T12:30:00.000Z' } }),
    ).createConnectSession({ integrationId: 'gmail', tags: { connect_attempt: 'n' } });
    expect(session).toEqual({ token: 'tok', expiresAt: new Date('2026-10-05T12:30:00.000Z') });
    const [call] = calls;
    expect(call?.url).toBe('https://api.nango.dev/connect/sessions');
    expect(call?.init.method).toBe('POST');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      tags: { connect_attempt: 'n' },
      allowed_integrations: ['gmail'],
    });
    expect((call?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer key-not-a-real-one',
    );
  });

  it('sets the webhook override only when given', async () => {
    calls.length = 0;
    await client(
      respond(201, { data: { token: 'tok', expires_at: '2026-10-05T12:30:00.000Z' } }),
    ).createConnectSession({
      integrationId: 'gmail',
      tags: {},
      webhookUrlOverride: 'https://abc.trycloudflare.com/webhooks/nango',
    });
    expect(JSON.parse(String(calls[0]?.init.body)).webhook_url_override).toBe(
      'https://abc.trycloudflare.com/webhooks/nango',
    );
  });

  it('looks connections up by tag, without credentials', async () => {
    calls.length = 0;
    const found = await client(
      respond(200, {
        connections: [
          {
            id: 1,
            connection_id: 'c1',
            provider: 'google-mail',
            provider_config_key: 'gmail',
            created: '2026-10-05T12:00:00.000Z',
            metadata: null,
            tags: { connect_attempt: 'n' },
            errors: [],
          },
        ],
      }),
    ).listConnectionsByTags({ connect_attempt: 'n' });
    expect(calls[0]?.url).toBe('https://api.nango.dev/connections?tags%5Bconnect_attempt%5D=n');
    expect(found).toEqual([
      {
        connectionId: 'c1',
        integrationId: 'gmail',
        provider: 'google-mail',
        tags: { connect_attempt: 'n' },
      },
    ]);
  });

  it('reports an auth error on a connection, and never returns credentials', async () => {
    const health = await client(
      respond(200, {
        id: 1,
        connection_id: 'c1',
        provider: 'google-mail',
        provider_config_key: 'gmail',
        tags: {},
        errors: [{ type: 'auth', log_id: 'x' }],
        credentials: { type: 'OAUTH2', access_token: 'secret-token' },
      }),
    ).getConnection({ integrationId: 'gmail', connectionId: 'c1' });
    expect(health.authError).toBe(true);
    expect(JSON.stringify(health)).not.toContain('secret-token');
  });

  it('treats deleting a connection that is gone as done', async () => {
    await expect(
      client(respond(404, { error: { code: 'not_found' } })).deleteConnection({
        integrationId: 'gmail',
        connectionId: 'c1',
      }),
    ).resolves.toEqual({ deleted: false });
  });

  it('throws typed errors without the response body', async () => {
    const error = await client(
      respond(400, { error: { code: 'invalid_body', message: 'jan@example.com is wrong' } }),
    )
      .createConnectSession({ integrationId: 'gmail', tags: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NangoApiError);
    expect(error).toMatchObject({ kind: 'rejected', status: 400, code: 'invalid_body' });
    expect(String((error as Error).message)).not.toContain('example.com');

    const down = await client(respond(503, {}))
      .listConnectionsByTags({})
      .catch((caught: unknown) => caught);
    expect(down).toMatchObject({ kind: 'unavailable', retryable: true });

    const network = await client(async () => {
      throw new TypeError('fetch failed');
    })
      .listConnectionsByTags({})
      .catch((caught: unknown) => caught);
    expect(network).toMatchObject({ kind: 'unavailable' });
  });

  it('refuses an answer that does not match its schema', async () => {
    await expect(
      client(respond(201, { data: { token: '' } })).createConnectSession({
        integrationId: 'gmail',
        tags: {},
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('triggers an action with the connection headers and parses its output', async () => {
    calls.length = 0;
    const output = await client(respond(200, { accountId: 'a1', email: 'x@y.z' })).triggerAction(
      { integrationId: 'gmail', connectionId: 'c1' },
      'account-info',
      z.object({ accountId: z.string() }),
    );
    expect(output).toEqual({ accountId: 'a1' });
    const headers = calls[0]?.init.headers as Record<string, string> | undefined;
    expect(headers?.['connection-id']).toBe('c1');
    expect(headers?.['provider-config-key']).toBe('gmail');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      action_name: 'account-info',
      input: {},
    });
  });
});

describe('externalAccountIdOf', () => {
  it('is the hash the validate-connection functions lock in Nango metadata', () => {
    // nango-integrations/<provider>/on-events/validate-connection.ts uses the same formula.
    const expected = createHash('sha256').update('gmail:info@bedrijf.example').digest('hex');
    expect(externalAccountIdOf('gmail', ' Info@Bedrijf.example ')).toBe(expected);
    expect(externalAccountIdOf('outlook', 'abc')).not.toBe(externalAccountIdOf('gmail', 'abc'));
  });
});
