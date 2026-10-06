import { type Database, recordWebhookDelivery, resolveConnection, withTenant } from '@effectief/db';
import {
  NANGO_SIGNATURE_HEADER,
  nangoDeliveryId,
  verifyNangoSignature,
} from '@effectief/integrations/nango';
import {
  isHandledNangoWebhook,
  type NangoWebhook,
  type NangoWebhookJob,
  nangoWebhookSchema,
  storedNangoWebhookSchema,
} from '@effectief/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ApiEnv } from '../env.ts';
import { AppError } from '../errors.ts';

/** Puts a stored delivery on the nango-webhook queue; one job per delivery. */
export type EnqueueNangoWebhook = (job: NangoWebhookJob) => Promise<void>;

export interface WebhookRouteDependencies {
  env: Pick<ApiEnv, 'NANGO_ENVIRONMENT' | 'NANGO_WEBHOOK_SIGNING_KEY'>;
  /** As app_runtime: the lookup functions and withTenant() only. */
  appDb: Database;
  enqueueNangoWebhook: EnqueueNangoWebhook;
}

/**
 * Webhook endpoints, each with `auth: 'hmac'` and its own verify function.
 * Registered via registerWebhookRoutes(), so bodies stay raw Buffers.
 */
export function createWebhookRoutes(deps: WebhookRouteDependencies) {
  return async (scope: FastifyInstance): Promise<void> => {
    scope.post(
      '/nango',
      {
        config: {
          auth: 'hmac',
          hmac: {
            verify: (request, rawBody) =>
              verifyNangoSignature(
                rawBody,
                request.headers[NANGO_SIGNATURE_HEADER],
                deps.env.NANGO_WEBHOOK_SIGNING_KEY,
              ),
          },
        },
      },
      async (request) => receiveNangoWebhook(deps, request.body as Buffer, request.log),
    );
  };
}

const ignored = { received: false } as const;

/**
 * docs/integrations.md §4.1, after the signature check: parse, check the
 * environment, find the tenant through our own database, store, enqueue,
 * answer. Anything that is not ours is logged with IDs and answered 200, so
 * Nango does not retry it; the body itself is never logged.
 */
async function receiveNangoWebhook(
  { env, appDb, enqueueNangoWebhook }: WebhookRouteDependencies,
  rawBody: Buffer,
  log: FastifyBaseLogger,
) {
  const receivedAt = new Date();
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    log.warn('nango webhook: body is not JSON');
    throw new AppError('BAD_REQUEST');
  }
  if (!isHandledNangoWebhook(body)) {
    log.info({ type: typeOf(body) }, 'nango webhook: type not handled, ignored');
    return ignored;
  }
  const parsed = nangoWebhookSchema.safeParse(body);
  if (!parsed.success) {
    // Paths only: the messages can quote values from the body.
    log.warn(
      { issues: parsed.error.issues.map((issue) => issue.path.join('.')) },
      'nango webhook: invalid body',
    );
    throw new AppError('BAD_REQUEST');
  }
  const webhook = parsed.data;
  const ids = idsOf(webhook);

  // Sync webhooks carry no environment; auth webhooks must be for ours.
  if (webhook.type === 'auth' && webhook.environment.toLowerCase() !== env.NANGO_ENVIRONMENT) {
    log.error({ ...ids, environment: webhook.environment }, 'nango webhook: other environment');
    return ignored;
  }

  const target = await resolveTarget(appDb, webhook);
  if (!target) {
    // Another environment on the shared Nango environment, the dashboard, or
    // a connection that is not ours (docs/integrations.md §7.4).
    log.info(ids, 'nango webhook: unknown connection, ignored');
    return ignored;
  }

  const { delivery } = await withTenant(appDb, target.tenantId, (tx) =>
    recordWebhookDelivery(tx, {
      connectionId: target.connectionId,
      source: 'nango',
      deliveryId: nangoDeliveryId(rawBody, webhook, receivedAt),
      payload: storedNangoWebhookSchema.parse(webhook),
    }),
  );
  // Also for a repeat that was not processed yet: the job ID makes a second
  // enqueue a no-op. If enqueueing fails, the 500 makes Nango retry.
  if (delivery.status !== 'processed') {
    await enqueueNangoWebhook({ tenantId: target.tenantId, deliveryId: delivery.id });
  }
  log.info(
    { ...ids, tenantId: target.tenantId, deliveryId: delivery.id },
    'nango webhook: received',
  );
  return { received: true } as const;
}

/**
 * The tenant comes from our database, never from the body's tags. A new
 * connection (`auth/creation`) is not in `connections` yet; it is found
 * through its connect attempt once that exists (docs/integrations.md §2.2).
 */
async function resolveTarget(appDb: Database, webhook: NangoWebhook) {
  if (webhook.type === 'auth' && webhook.operation === 'creation') return undefined;
  return resolveConnection(appDb, webhook.providerConfigKey, webhook.connectionId);
}

function idsOf(webhook: NangoWebhook) {
  return {
    type: webhook.type,
    ...(webhook.type === 'auth' ? { operation: webhook.operation } : {}),
    integrationId: webhook.providerConfigKey,
    nangoConnectionId: webhook.connectionId,
  };
}

function typeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('type' in body)) return undefined;
  const { type } = body as { type: unknown };
  return typeof type === 'string' ? type.slice(0, 50) : undefined;
}
