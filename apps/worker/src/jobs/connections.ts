import {
  CONNECT_ATTEMPT_MAX_AGE_MS,
  failConnectAttempt,
  getConnectAttempt,
  listConnections,
  listOpenConnectAttempts,
  listTenantIds,
  withTenant,
} from '@effectief/db';
import { nangoProviders } from '@effectief/integrations/nango';
import {
  connectAttemptJobSchema,
  connectionSweepJobNames,
  connectionSweepJobSchema,
  connectionSweepTenantJobSchema,
  defaultJobOptions,
} from '@effectief/shared';
import type { Queue } from 'bullmq';
import { finishConnectAttempt } from '../connections/connect.ts';
import { checkConnectionHealth, type LifecycleDependencies } from '../connections/lifecycle.ts';

// Jobs around connecting (docs/integrations.md §2.3, §4.6): finishing an
// attempt found by connections.complete, and the sweeps that make sure no
// missed webhook leaves a connection in the wrong state for long.

/** Wait this long before the sweep looks for an attempt: the user may still be busy. */
const ATTEMPT_GRACE_MS = 30 * 60 * 1000;

const connectionSweepSchedules = {
  attempts: { every: 10 * 60 * 1000 },
  health: { every: 60 * 60 * 1000 },
} as const;

/** Idempotent: run at every worker start, updates the two schedulers. */
export async function scheduleConnectionSweeps(queue: Queue) {
  await queue.upsertJobScheduler('connection-sweep-attempts', connectionSweepSchedules.attempts, {
    name: connectionSweepJobNames.attempts,
    data: {},
    opts: defaultJobOptions,
  });
  await queue.upsertJobScheduler('connection-sweep-health', connectionSweepSchedules.health, {
    name: connectionSweepJobNames.health,
    data: {},
    opts: defaultJobOptions,
  });
}

/** From connections.complete: the Nango connection was found by the attempt's nonce tag. */
export async function processConnectAttemptJob(
  data: unknown,
  job: { jobId: string },
  deps: LifecycleDependencies,
) {
  const { tenantId, attemptId, nangoConnectionId } = connectAttemptJobSchema.parse(data);
  const attempt = await withTenant(deps.db, tenantId, (tx) => getConnectAttempt(tx, attemptId));
  if (!attempt) return { result: 'not_open' as const };
  const result = await finishConnectAttempt(deps, {
    tenantId,
    attemptId,
    nangoConnectionId,
    integrationId: attempt.nangoIntegrationId,
    jobId: job.jobId,
    commit: (fn) => withTenant(deps.db, tenantId, fn),
  });
  return { result };
}

/** The sweeps list tenant ids only and enqueue one job per tenant (as retention, #052). */
export async function processConnectionSweep(
  name: string,
  data: unknown,
  {
    db,
    enqueueTenants,
  }: Pick<LifecycleDependencies, 'db'> & {
    enqueueTenants: (jobs: { name: string; tenantId: string }[]) => Promise<void>;
  },
) {
  connectionSweepJobSchema.parse(data);
  const tenantJob =
    name === connectionSweepJobNames.attempts
      ? connectionSweepJobNames.tenantAttempts
      : connectionSweepJobNames.tenantHealth;
  const tenantIds = await listTenantIds(db);
  await enqueueTenants(tenantIds.map((tenantId) => ({ name: tenantJob, tenantId })));
  return { tenants: tenantIds.length };
}

/**
 * Open attempts of one tenant (§2.3): between 30 minutes and a day old, look
 * the connection up at Nango by the nonce and finish it as the webhook would;
 * older than a day, remove what Nango has for it and close the attempt.
 */
export async function processTenantAttempts(
  data: unknown,
  job: { jobId: string },
  deps: LifecycleDependencies,
) {
  const now = deps.now?.() ?? new Date();
  const { tenantId } = connectionSweepTenantJobSchema.parse(data);
  const { db, nango, log } = deps;
  const attempts = await withTenant(db, tenantId, (tx) =>
    listOpenConnectAttempts(tx, { createdBefore: new Date(now.getTime() - ATTEMPT_GRACE_MS) }),
  );
  const counts = { finished: 0, expired: 0, failed: 0 };
  for (const attempt of attempts) {
    const ids = { tenantId, attemptId: attempt.id, jobId: job.jobId };
    try {
      const found = (await nango.listConnectionsByTags({ connect_attempt: attempt.nonce })).filter(
        (connection) => connection.integrationId === attempt.nangoIntegrationId,
      );
      const expired = now.getTime() - attempt.createdAt.getTime() >= CONNECT_ATTEMPT_MAX_AGE_MS;
      const [only] = found;
      if (!expired && found.length === 1 && only) {
        await finishConnectAttempt(deps, {
          tenantId,
          attemptId: attempt.id,
          nangoConnectionId: only.connectionId,
          integrationId: attempt.nangoIntegrationId,
          jobId: job.jobId,
          commit: (fn) => withTenant(db, tenantId, fn),
        });
        counts.finished += 1;
      } else if (expired) {
        for (const connection of found) await nango.deleteConnection(connection);
        await withTenant(db, tenantId, (tx) =>
          failConnectAttempt(tx, {
            attemptId: attempt.id,
            failureCode: 'expired',
            context: { jobId: job.jobId },
          }),
        );
        counts.expired += 1;
      }
    } catch (error) {
      // One attempt must not block the others; the next sweep tries again.
      counts.failed += 1;
      log.error({ ...ids, err: error }, 'sweep of connect attempt failed');
    }
  }
  log.info({ tenantId, jobId: job.jobId, ...counts }, 'connect attempts swept');
  return counts;
}

/** Each active or expired Nango connection of one tenant, checked at Nango (§4.6). */
export async function processTenantHealth(
  data: unknown,
  job: { jobId: string },
  deps: LifecycleDependencies,
) {
  const { tenantId } = connectionSweepTenantJobSchema.parse(data);
  const connections = await withTenant(deps.db, tenantId, (tx) => listConnections(tx));
  const counts: Record<string, number> = {};
  for (const connection of connections) {
    if (!(nangoProviders as string[]).includes(connection.provider)) continue;
    try {
      const result = await checkConnectionHealth(deps, { tenantId, connection, jobId: job.jobId });
      counts[result] = (counts[result] ?? 0) + 1;
    } catch (error) {
      counts.failed = (counts.failed ?? 0) + 1;
      deps.log.error(
        { tenantId, connectionId: connection.id, jobId: job.jobId, err: error },
        'connection health check failed',
      );
    }
  }
  deps.log.info({ tenantId, jobId: job.jobId, ...counts }, 'connection health checked');
  return counts;
}
