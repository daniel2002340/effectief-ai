import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.ts';
import {
  MonitoringTestError,
  monitoringEnvSchema,
  monitoringTestData,
  type ScrubbableEvent,
  scrubBreadcrumb,
  scrubErrorText,
  scrubEvent,
  testErrorsEnabled,
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
    expect(
      parseEnv(monitoringEnvSchema, {
        ...valid,
        SENTRY_DSN: 'disabled',
        SENTRY_ENVIRONMENT: 'development',
      }).SENTRY_DSN,
    ).toBe('disabled');
    expect(() => parseEnv(monitoringEnvSchema, { ...valid, SENTRY_DSN: '' })).toThrow(/SENTRY_DSN/);
    expect(() =>
      parseEnv(monitoringEnvSchema, { ...valid, SENTRY_DSN: 'http://abc@sentry.local/1' }),
    ).toThrow(/SENTRY_DSN/);
  });

  it('allows "disabled" only outside staging and production', () => {
    for (const environment of ['development', 'test', 'ci', 'stack']) {
      expect(
        parseEnv(monitoringEnvSchema, {
          ...valid,
          SENTRY_DSN: 'disabled',
          SENTRY_ENVIRONMENT: environment,
        }).SENTRY_DSN,
      ).toBe('disabled');
    }
    for (const environment of ['staging', 'production']) {
      expect(() =>
        parseEnv(monitoringEnvSchema, {
          ...valid,
          SENTRY_DSN: 'disabled',
          SENTRY_ENVIRONMENT: environment,
        }),
      ).toThrow(/SENTRY_DSN: Monitoring cannot be disabled/);
    }
  });

  it('accepts known environments only', () => {
    for (const environment of ['prod', 'Production', 'staging2', '']) {
      expect(() =>
        parseEnv(monitoringEnvSchema, { ...valid, SENTRY_ENVIRONMENT: environment }),
      ).toThrow(/SENTRY_ENVIRONMENT/);
    }
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

describe('scrubErrorText', () => {
  it('removes email addresses and the values the error carries under sensitive keys', () => {
    const error = new MonitoringTestError('api');
    const scrubbed = scrubErrorText(`${error.message}\n${error.stack}`, error);
    expect(scrubbed).not.toContain(monitoringTestData.email);
    expect(scrubbed).not.toContain(monitoringTestData.name);
    expect(scrubbed).toContain('MonitoringTestError: Testfout in api voor [redacted] <[email]>');
  });

  it('keeps stack frames with package versions readable', () => {
    const frame =
      'at file:///app/node_modules/.pnpm/@orpc+server@1.15.4_@opentelemetry+api@1.9.1_fastify@5.12.5/node_modules/@orpc/server/dist/shared/server.CMf4nKky.mjs:231:32';
    expect(scrubErrorText(frame, new Error('x'))).toBe(frame);
  });

  it('follows the cause chain and ignores values too short to remove safely', () => {
    const cause = Object.assign(new Error('x'), { customer: { name: 'Ab' }, firstName: 'Pieter' });
    const error = new Error('Pieter en Ab', { cause });
    expect(scrubErrorText(error.message, error)).toBe('[redacted] en Ab');
  });
});

describe('scrubEvent with the original error', () => {
  it('leaves neither the fake address nor the fake name of the test error', () => {
    const error = new MonitoringTestError('worker');
    const scrubbed = scrubEvent(
      {
        exception: { values: [{ value: error.message }] },
        contexts: { MonitoringTestError: { context: error.context } },
      },
      { originalException: error },
    );
    const serialized = JSON.stringify(scrubbed);
    for (const leaked of Object.values(monitoringTestData)) {
      expect(serialized).not.toContain(leaked);
    }
    expect(scrubbed.exception?.values?.[0]?.value).toBe(
      'Testfout in worker voor [redacted] <[email]>',
    );
    expect(scrubbed.contexts).toMatchObject({
      MonitoringTestError: { context: { service: 'worker' } },
    });
  });
});

describe('testErrorsEnabled', () => {
  it('is off in production only', () => {
    expect(testErrorsEnabled('production')).toBe(false);
    for (const environment of ['development', 'test', 'ci', 'stack', 'staging'] as const) {
      expect(testErrorsEnabled(environment)).toBe(true);
    }
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
