import { createHash } from 'node:crypto';
import type { NangoWebhook } from '@effectief/shared';

/**
 * Nango sends no delivery ID (§4.4). A sync webhook is unique per run, so the
 * body's hash is its ID. An auth webhook can come again with exactly the same
 * body weeks later (a second refresh failure) and must then be processed
 * again, while Nango's own retries come within a second: its ID is the body's
 * hash plus the hour of receipt.
 */
export function nangoDeliveryId(rawBody: Buffer, webhook: NangoWebhook, receivedAt: Date): string {
  const hash = createHash('sha256').update(rawBody);
  if (webhook.type === 'auth') hash.update(`\n${receivedAt.toISOString().slice(0, 13)}`);
  return hash.digest('hex');
}
