import { z } from 'zod';

/** Every job payload carries its tenant (CLAUDE.md, tenant isolation). */
const tenantJobSchema = z.object({
  tenantId: z.uuid(),
});

export const queueNames = {
  example: 'example',
  executeAction: 'execute-action',
  retention: 'retention',
  forgetEntity: 'forget-entity',
  purgeConnection: 'purge-connection',
  nangoWebhook: 'nango-webhook',
  connectAttempt: 'connect-attempt',
  connectionSweep: 'connection-sweep',
  mailIngest: 'mail-ingest',
  /** Only outside production: a job that fails on purpose (decision #069). */
  monitoringTest: 'monitoring-test',
} as const;

/** The tenant of a job payload as parsed by Zod, or undefined without a valid one. */
export function tenantIdOf(data: unknown): string | undefined {
  const parsed = tenantJobSchema.safeParse(data);
  return parsed.success ? parsed.data.tenantId : undefined;
}

export const exampleJobSchema = tenantJobSchema.extend({
  note: z.string().min(1).max(500),
});
export type ExampleJob = z.infer<typeof exampleJobSchema>;

/**
 * Executes one approved action through its adapter. Starting the job never
 * bypasses approval: the job only claims an action that is `approved`.
 */
export const executeActionJobSchema = tenantJobSchema.extend({
  actionId: z.uuid(),
});
export type ExecuteActionJob = z.infer<typeof executeActionJobSchema>;

/**
 * One job per approval: a second enqueue for the same approval is ignored by
 * BullMQ. A retry after a failure is a new approval, so a new job.
 */
export const executeActionJobId = (actionId: string, approvedAt: Date) =>
  `execute-${actionId}-${approvedAt.getTime()}`;

/**
 * Retention (#037) runs as two jobs in one queue. `sweep` is the one job
 * without a tenant: it only lists tenant ids (list_tenant_ids()) and enqueues
 * one `tenant` job per tenant, which does the work within withTenant().
 */
export const retentionJobNames = { sweep: 'sweep', tenant: 'tenant' } as const;
export const retentionSweepJobSchema = z.strictObject({});
export const retentionTenantJobSchema = tenantJobSchema;
export type RetentionTenantJob = z.infer<typeof retentionTenantJobSchema>;

/** One retention job per tenant per day, also when the sweep runs twice. */
export const retentionTenantJobId = (tenantId: string, day: Date) =>
  `retention-${tenantId}-${day.toISOString().slice(0, 10)}`;

/** Forgetting a person on request of an owner (docs/data-model.md §6.3). */
export const forgetEntityJobSchema = tenantJobSchema.extend({
  entityId: z.uuid(),
  requestedByUserId: z.uuid(),
});
export type ForgetEntityJob = z.infer<typeof forgetEntityJobSchema>;

/** Deletes the data of a revoked connection and marks it purged. */
export const purgeConnectionJobSchema = tenantJobSchema.extend({
  connectionId: z.uuid(),
});
export type PurgeConnectionJob = z.infer<typeof purgeConnectionJobSchema>;

/**
 * Processes one stored webhook delivery (#038, docs/integrations.md §4.1).
 * The tenant came from resolve_connection(), never from the body.
 */
export const nangoWebhookJobSchema = tenantJobSchema.extend({
  deliveryId: z.uuid(),
});
export type NangoWebhookJob = z.infer<typeof nangoWebhookJobSchema>;

/** One job per delivery: a repeated webhook adds nothing to the queue. */
export const nangoWebhookJobId = (deliveryId: string) => `nango-webhook-${deliveryId}`;

/**
 * Turns a connect attempt into a connection, for a Nango connection found by
 * the attempt's tag (docs/integrations.md §2.3): the same work as the
 * creation webhook, when that webhook did not arrive.
 */
export const connectAttemptJobSchema = tenantJobSchema.extend({
  attemptId: z.uuid(),
  nangoConnectionId: z.string().regex(/^[\w.:@-]{1,200}$/),
});
export type ConnectAttemptJob = z.infer<typeof connectAttemptJobSchema>;

export const connectAttemptJobId = (attemptId: string) => `connect-attempt-${attemptId}`;

/** One purge per connection: disconnecting twice does not purge twice. */
export const purgeConnectionJobId = (connectionId: string) => `purge-${connectionId}`;

/**
 * The safety net for missed webhooks (docs/integrations.md §4.6), as two
 * fan-outs like retention: `attempts` every 10 minutes looks up open connect
 * attempts at Nango; `health` every hour checks each connection at Nango.
 * The sweeps only list tenant ids; the per-tenant jobs do the work.
 */
export const connectionSweepJobNames = {
  attempts: 'attempts',
  health: 'health',
  tenantAttempts: 'tenant-attempts',
  tenantHealth: 'tenant-health',
} as const;
export const connectionSweepJobSchema = z.strictObject({});
export const connectionSweepTenantJobSchema = tenantJobSchema;

/**
 * Mail ingest (docs/integrations.md §4.2–§4.3, #076): `connection` reads a
 * mail connection's Nango records from its cursor; the sync webhook and the
 * sweep enqueue it. `sweep` (every 10 minutes, without a tenant like
 * retention) lists tenant ids; `tenant` enqueues one `connection` job per
 * active mail connection of that tenant.
 */
export const mailIngestJobNames = {
  sweep: 'sweep',
  tenant: 'tenant',
  connection: 'connection',
} as const;
export const mailIngestSweepJobSchema = z.strictObject({});
export const mailIngestTenantJobSchema = tenantJobSchema;
export const mailIngestJobSchema = tenantJobSchema.extend({
  connectionId: z.uuid(),
});
export type MailIngestJob = z.infer<typeof mailIngestJobSchema>;

/**
 * At most one waiting or running ingest per connection: the webhook and the
 * sweep do not read the same records twice. While one runs, a new one is
 * dropped; the next webhook or sweep picks up what came in after.
 */
export const mailIngestDeduplicationId = ({ tenantId, connectionId }: MailIngestJob) =>
  `mail-ingest-${tenantId}-${connectionId}`;

/** Nothing but the tenant: the job fails on purpose and needs no data. */
export const monitoringTestJobSchema = tenantJobSchema.strict();
export type MonitoringTestJob = z.infer<typeof monitoringTestJobSchema>;

/** Retries with backoff; failed jobs are kept so no failure disappears silently. */
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: false,
} as const;

/** Two quick attempts: the test job shows a retry and then the report after the last one. */
export const monitoringTestJobOptions = {
  ...defaultJobOptions,
  attempts: 2,
  backoff: { type: 'fixed', delay: 500 },
  removeOnFail: { age: 24 * 60 * 60, count: 100 },
} as const;
