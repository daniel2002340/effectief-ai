import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.ts';
import {
  monitoringEnvSchema,
  type ScrubbableEvent,
  scrubBreadcrumb,
  scrubEvent,
} from './monitoring.ts';

const email = 'jan.jansen@bedrijf.nl';

describe('monitoringEnvSchema', () => {
  const valid = {
    SENTRY_DSN: 'https://abc@o1.ingest.de.sentry.io/2',
    SENTRY_ENVIRONMENT: 'staging',
    APP_RELEASE: '0d5d691',
  };

  it('accepts a DSN or an explicit "disabled", nothing else', () => {
    expect(parseEnv(monitoringEnvSchema, valid).SENTRY_DSN).toBe(valid.SENTRY_DSN);
    expect(parseEnv(monitoringEnvSchema, { ...valid, SENTRY_DSN: 'disabled' }).SENTRY_DSN).toBe(
      'disabled',
    );
    expect(() => parseEnv(monitoringEnvSchema, { ...valid, SENTRY_DSN: '' })).toThrow(/SENTRY_DSN/);
    expect(() =>
      parseEnv(monitoringEnvSchema, { ...valid, SENTRY_DSN: 'http://abc@sentry.local/1' }),
    ).toThrow(/SENTRY_DSN/);
  });

  it('requires a release and an environment', () => {
    expect(() => parseEnv(monitoringEnvSchema, { SENTRY_DSN: 'disabled' })).toThrow(
      /APP_RELEASE[\s\S]*|SENTRY_ENVIRONMENT/,
    );
  });
});

describe('scrubEvent', () => {
  function event(): ScrubbableEvent {
    return {
      message: `Mail van ${email} mislukt`,
      request: {
        url: `https://staging.effectiefai.nl/api/x?email=${email}`,
        data: { email, password: 'geheim' },
        cookies: { 'better-auth.session_token': 'abc' },
        query_string: `email=${email}`,
        headers: {
          Cookie: 'better-auth.session_token=abc',
          Authorization: 'Bearer abc',
          'X-Real-IP': '203.0.113.7',
          'Content-Type': 'application/json',
          'User-Agent': 'test',
        },
        env: { REMOTE_ADDR: '203.0.113.7' },
      },
      user: {
        id: 'u-1',
        email,
        ip_address: '203.0.113.7',
        username: 'jan',
      } as ScrubbableEvent['user'],
      exception: {
        values: [{ value: `duplicate key value violates unique constraint (${email})` }],
      },
      extra: {
        error: {
          detail: `Key (email)=(${email}) already exists.`,
          where: 'SQL function',
          code: '23505',
        },
        payload: { customer: { name: 'Jan Jansen', note: `bel ${email}` } },
      },
      contexts: { job: { queue: 'execute-action', subject: 'Offerte Jansen' } },
      breadcrumbs: [
        { category: 'console', message: `log ${email}` },
        { category: 'http', data: { url: `https://api.example/x?token=abc`, method: 'GET' } },
      ],
    };
  }

  it('leaves no email address, name, body, cookie or IP anywhere in the event', () => {
    const scrubbed = JSON.stringify(scrubEvent(event()));
    for (const leaked of [
      email,
      'Jan Jansen',
      'geheim',
      'session_token',
      '203.0.113.7',
      'Bearer',
      'Offerte Jansen',
      'token=abc',
      'jan"',
    ]) {
      expect(scrubbed).not.toContain(leaked);
    }
  });

  it('keeps what helps debugging: IDs, codes, paths and safe headers', () => {
    const scrubbed = scrubEvent(event());
    expect(scrubbed.user).toEqual({ id: 'u-1' });
    expect(scrubbed.request).toEqual({
      url: 'https://staging.effectiefai.nl/api/x',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'test' },
    });
    expect(scrubbed.extra).toMatchObject({ error: { code: '23505', detail: '[redacted]' } });
    expect(scrubbed.contexts).toMatchObject({ job: { queue: 'execute-action' } });
    expect(scrubbed.message).toBe('Mail van [email] mislukt');
  });
});

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull();
  });

  it('strips query strings from URLs', () => {
    expect(
      scrubBreadcrumb({ category: 'navigation', data: { from: '/a?x=1', to: '/b?email=a@b.nl' } }),
    ).toEqual({ category: 'navigation', data: { from: '/a', to: '/b' } });
  });
});
