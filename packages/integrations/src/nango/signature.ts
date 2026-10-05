import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header Nango signs webhooks with; `X-Nango-Signature` is legacy. */
export const NANGO_SIGNATURE_HEADER = 'x-nango-hmac-sha256';

/**
 * HMAC-SHA256 (hex) of the exact bytes received, with the environment's
 * webhook signing key (not the API key). Constant-time comparison; a missing
 * or malformed header is simply invalid.
 */
export function verifyNangoSignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  signingKey: string,
): boolean {
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

/** For tests and local tools: the header value Nango would send for a body. */
export function signNangoBody(rawBody: Buffer | string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(rawBody).digest('hex');
}
