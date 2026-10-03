import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/logger.ts';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const { serializers: _serializers, ...options } = loggerOptions({ LOG_LEVEL: 'info' });
  return { logger: pino(options, stream), output: () => lines.join('') };
}

describe('logger redaction', () => {
  it('censors personal data at any of the first levels', () => {
    const { logger, output } = capture();
    logger.info(
      {
        email: 'jan@voorbeeld.nl',
        customer: { name: 'Jan Jansen', email: 'jan@voorbeeld.nl' },
        message: { body: 'Beste Jan, ...', subject: 'Offerte' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=abc' } },
        mailId: 'msg_123',
      },
      'incoming mail',
    );
    const logged = output();
    expect(logged).not.toMatch(/jan@voorbeeld|Jan Jansen|Beste Jan|Offerte|Bearer abc|sid=abc/);
    expect(logged).toContain('msg_123');
  });
});
