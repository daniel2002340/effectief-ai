import { randomUUID } from 'node:crypto';
import {
  type Action,
  approveAction,
  claimExecution,
  eq,
  getAction,
  getCard,
  getConnection,
  listAuditLog,
  listFeed,
  proposeAction,
  rejectAction,
  reopenAction,
  schema,
  type TenantTransaction,
  transitionConnection,
  withTenant,
} from '@effectief/db';
import {
  agent,
  asUser,
  createTestCard,
  createTestConnection,
  openTestDatabases,
  quoteInput,
  replyInput,
  type TestTenant,
} from '@effectief/db/testing';
import { AdapterError } from '@effectief/integrations';
import {
  createFakeNango,
  createFakeProvider,
  type FakeProvider,
  nangoTestEnv,
} from '@effectief/integrations/testing';
import { defaultJobOptions, executeActionJobId, parseEnv, queueNames } from '@effectief/shared';
import { Queue, QueueEvents } from 'bullmq';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerEnvSchema } from '../src/env.ts';
import { type ExecuteJobInfo, processExecuteActionJob } from '../src/jobs/execute-action.ts';
import { startWorkers } from '../src/worker.ts';

// The action pipeline from approval to the provider (#004, decision #050),
// against Postgres as app_runtime and a fake provider that counts effects.

const env = parseEnv(workerEnvSchema, { ...process.env, ...nangoTestEnv, LOG_LEVEL: 'silent' });
const log = pino({ level: 'silent' });
const db = openTestDatabases();
let tenant: TestTenant;
let other: TestTenant;
let fake: FakeProvider;

beforeAll(async () => {
  tenant = await db.createTenant();
  other = await db.createTenant();
});
afterAll(() => db.close());
beforeEach(() => {
  fake = createFakeProvider();
});

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);
const user = () => asUser(tenant.userId);

function run(actionId: string, job: Partial<ExecuteJobInfo> = {}, tenantId = tenant.tenantId) {
  return processExecuteActionJob(
    { tenantId, actionId },
    { jobId: `job-${randomUUID()}`, attemptsMade: 0, maxAttempts: 3, ...job },
    { db: db.app.db, adapters: fake.adapters, log },
  );
}

/** A concept quote on its own card, via an active Moneybird connection. */
function proposeQuote(): Promise<Action> {
  return inTenant(async (tx) => {
    const connection = await createTestConnection(tx, tenant, 'moneybird');
    const card = await createTestCard(tx);
    const { action } = await proposeAction(tx, {
      cardId: card.id,
      connectionId: connection.id,
      type: 'moneybird.quote',
      input: quoteInput,
      actor: agent,
    });
    return action;
  });
}

function proposeReply(): Promise<Action> {
  return inTenant(async (tx) => {
    const connection = await createTestConnection(tx, tenant);
    const card = await createTestCard(tx);
    const { action } = await proposeAction(tx, {
      cardId: card.id,
      connectionId: connection.id,
      type: 'email.reply',
      input: replyInput,
      actor: agent,
    });
    return action;
  });
}

const approve = (actionId: string, input?: Record<string, unknown>) =>
  inTenant((tx) => approveAction(tx, { actionId, input, actor: user() }));
const load = async (actionId: string) => {
  const action = await inTenant((tx) => getAction(tx, actionId));
  if (!action) throw new Error('action not found');
  return action;
};
const auditOf = (actionId: string) =>
  inTenant((tx) => listAuditLog(tx, { objectType: 'actions', objectId: actionId }));
const failureCards = (actionId: string) =>
  inTenant(async (tx) => (await listFeed(tx, 200)).filter((card) => card.actionId === actionId));

describe('without approval nothing is executed', () => {
  it.each(['concept', 'rejected'] as const)(
    'a job for a %s action does nothing, also when started directly',
    async (status) => {
      const action = await proposeQuote();
      if (status === 'rejected') {
        await inTenant((tx) => rejectAction(tx, { actionId: action.id, actor: user() }));
      }
      await expect(run(action.id)).resolves.toEqual({ outcome: 'skipped', status });
      expect(fake.calls).toHaveLength(0);
      expect(fake.effects).toEqual({ created: 0, updated: 0 });
      expect((await load(action.id)).status).toBe(status);
      expect((await auditOf(action.id)).map((e) => e.action)).not.toContain('action.started');
    },
  );

  it('a job with the action of another tenant finds nothing', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    await expect(run(action.id, {}, other.tenantId)).resolves.toEqual({
      outcome: 'skipped',
      status: 'not_found',
    });
    expect(fake.calls).toHaveLength(0);
    expect((await load(action.id)).status).toBe('approved');
  });

  it('only a member of the tenant can approve', async () => {
    const action = await proposeQuote();
    await expect(
      inTenant((tx) => approveAction(tx, { actionId: action.id, actor: asUser(other.userId) })),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
    expect((await load(action.id)).status).toBe('concept');
  });
});

describe('a repeat has exactly one effect at the provider', () => {
  it('double approve: one approval wins, executing it creates one object', async () => {
    const action = await proposeQuote();
    const approvals = await Promise.allSettled([approve(action.id), approve(action.id)]);
    expect(approvals.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(approvals.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { name: 'TransitionError', code: 'status_changed' },
    });

    await expect(run(action.id)).resolves.toMatchObject({ outcome: 'executed' });
    await expect(run(action.id)).resolves.toEqual({ outcome: 'skipped', status: 'executed' });
    expect(fake.effects).toEqual({ created: 1, updated: 0 });
    const audit = await auditOf(action.id);
    expect(audit.filter((e) => e.action === 'action.approved')).toHaveLength(1);
  });

  it('double execute: two jobs at once, one provider call', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    fake.delayMs = 100;
    const outcomes = await Promise.all([run(action.id), run(action.id)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['executed', 'skipped']);
    expect(fake.calls).toHaveLength(1);
    expect(fake.effects).toEqual({ created: 1, updated: 0 });
    expect(await load(action.id)).toMatchObject({ status: 'executed', attempts: 1 });
  });

  it('a second job while the first is at the provider does nothing', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    fake.delayMs = 200;
    const first = run(action.id);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await expect(run(action.id)).resolves.toEqual({ outcome: 'skipped', status: 'executing' });
    await expect(first).resolves.toMatchObject({ outcome: 'executed' });
    expect(fake.effects).toEqual({ created: 1, updated: 0 });
  });

  it('a retry after a crash between provider and database creates no second object', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    // The first attempt claimed and reached the provider, then died before recording.
    const jobId = `job-${randomUUID()}`;
    await inTenant((tx) => claimExecution(tx, { actionId: action.id, jobId }));
    const adapter = fake.adapters.moneybird;
    await adapter?.execute({
      type: 'moneybird.quote',
      input: quoteInput,
      connection: {
        tenantId: tenant.tenantId,
        connectionId: action.connectionId,
        provider: 'moneybird',
        nangoIntegrationId: 'moneybird',
        nangoConnectionId: 'conn',
      },
      idempotencyKey: action.idempotencyKey,
      providerObjectId: null,
    });

    // The retry of the same job resumes; another job does not.
    await expect(run(action.id)).resolves.toEqual({ outcome: 'skipped', status: 'executing' });
    const outcome = await run(action.id, { jobId, attemptsMade: 1 });
    expect(outcome).toEqual({ outcome: 'executed', providerObjectId: 'fake-1' });
    expect(fake.effects).toEqual({ created: 1, updated: 0 });
    expect((await load(action.id)).attempts).toBe(1);
  });

  it('executing records an event on the card and closes the card', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    await run(action.id);
    const { card, events } = await inTenant(async (tx) => ({
      card: await getCard(tx, action.cardId),
      events: await tx
        .select()
        .from(schema.events)
        .where(eq(schema.events.causedByActionId, action.id)),
    }));
    expect(card?.status).toBe('done');
    expect(events).toMatchObject([
      { type: 'action.executed', source: 'app', payload: { providerObjectId: 'fake-1' } },
    ]);
    expect((await auditOf(action.id)).map((e) => [e.action, e.actorType])).toEqual([
      ['action.proposed', 'agent'],
      ['action.approved', 'user'],
      ['action.started', 'system'],
      ['action.executed', 'system'],
    ]);
  });
});

describe('editing an executed action updates the provider object', () => {
  it('edit, approve and execute again: an update of the same object', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    await run(action.id);
    const first = await load(action.id);

    await inTenant((tx) => reopenAction(tx, { actionId: action.id, actor: user() }));
    await approve(action.id, { ...quoteInput, reference: 'Aangepast' });
    await expect(run(action.id)).resolves.toEqual({
      outcome: 'executed',
      providerObjectId: first.providerObjectId,
    });

    expect(fake.effects).toEqual({ created: 1, updated: 1 });
    expect(fake.objects.size).toBe(1);
    const object = fake.objects.get(first.providerObjectId ?? '');
    expect(object).toMatchObject({ version: 2, input: { reference: 'Aangepast' } });
    expect(fake.calls[1]?.providerObjectId).toBe(first.providerObjectId);
    expect(await load(action.id)).toMatchObject({
      status: 'executed',
      providerObjectId: first.providerObjectId,
      attempts: 2,
    });
  });

  it('a sent mail cannot be edited after executing', async () => {
    const action = await proposeReply();
    await approve(action.id);
    await run(action.id);
    await expect(
      inTenant((tx) => reopenAction(tx, { actionId: action.id, actor: user() })),
    ).rejects.toMatchObject({ name: 'TransitionError', code: 'invalid_transition' });
    expect(fake.effects).toEqual({ created: 1, updated: 0 });
  });
});

describe('a failed execution never disappears silently', () => {
  it('a refused input: failed with the code, a card for the user and an audit entry', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    fake.failNext(new AdapterError('rejected_by_provider', { retryable: false }));

    await expect(run(action.id)).resolves.toEqual({
      outcome: 'failed',
      errorCode: 'rejected_by_provider',
    });
    expect(await load(action.id)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'rejected_by_provider',
    });
    const cards = await failureCards(action.id);
    expect(cards).toMatchObject([
      {
        kind: 'action_failed',
        status: 'open',
        priority: 3,
        title: 'Offerte niet klaargezet in Moneybird',
        payload: { errorCode: 'rejected_by_provider' },
      },
    ]);
    const failed = (await auditOf(action.id)).find((e) => e.action === 'action.failed');
    expect(failed?.metadata).toMatchObject({ errorCode: 'rejected_by_provider', attempts: 1 });
    // The card of the action stays open as well.
    expect((await inTenant((tx) => getCard(tx, action.cardId)))?.status).toBe('open');
  });

  it('a provider outage is retried, and fails with a card after the last attempt', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    const outage = new AdapterError('provider_unavailable', { retryable: true });
    fake.failNext(outage, 2);
    const jobId = `job-${randomUUID()}`;

    await expect(run(action.id, { jobId, attemptsMade: 0, maxAttempts: 2 })).rejects.toBe(outage);
    expect(await load(action.id)).toMatchObject({ status: 'executing', executionJobId: jobId });
    expect(await failureCards(action.id)).toHaveLength(0);

    await expect(run(action.id, { jobId, attemptsMade: 1, maxAttempts: 2 })).resolves.toEqual({
      outcome: 'failed',
      errorCode: 'provider_unavailable',
    });
    expect(fake.calls).toHaveLength(2);
    expect(await failureCards(action.id)).toHaveLength(1);
  });

  it('an expired grant fails at once and expires the connection with its own card', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    fake.failNext(new AdapterError('auth_expired', { retryable: false }));
    await expect(run(action.id)).resolves.toEqual({ outcome: 'failed', errorCode: 'auth_expired' });

    const connection = await inTenant((tx) => getConnection(tx, action.connectionId));
    expect(connection).toMatchObject({ status: 'expired', statusReason: 'invalid_grant' });
    const feed = await inTenant((tx) => listFeed(tx, 200));
    expect(feed.filter((card) => card.connectionId === action.connectionId)).toMatchObject([
      { kind: 'connection_problem', title: 'Koppeling met Moneybird opnieuw maken' },
    ]);
    expect(await failureCards(action.id)).toHaveLength(1);
  });

  it('no call without an active connection or an adapter', async () => {
    const revoked = await proposeQuote();
    await approve(revoked.id);
    await inTenant((tx) =>
      transitionConnection(tx, {
        connectionId: revoked.connectionId,
        from: 'active',
        to: 'revoked',
        reason: 'user_disconnected',
        actor: user(),
      }),
    );
    await expect(run(revoked.id)).resolves.toEqual({
      outcome: 'failed',
      errorCode: 'connection_inactive',
    });

    const unsupported = await proposeQuote();
    await approve(unsupported.id);
    await expect(
      processExecuteActionJob(
        { tenantId: tenant.tenantId, actionId: unsupported.id },
        { jobId: `job-${randomUUID()}`, attemptsMade: 0, maxAttempts: 3 },
        { db: db.app.db, adapters: {}, log },
      ),
    ).resolves.toEqual({ outcome: 'failed', errorCode: 'unsupported' });

    expect(fake.calls).toHaveLength(0);
    expect(await failureCards(revoked.id)).toHaveLength(1);
    expect(await failureCards(unsupported.id)).toHaveLength(1);
  });

  it('retrying after a new approval closes the failure card and executes once', async () => {
    const action = await proposeQuote();
    await approve(action.id);
    fake.failNext(new AdapterError('rejected_by_provider', { retryable: false }));
    await run(action.id);

    await approve(action.id);
    expect(await failureCards(action.id)).toHaveLength(0);
    await expect(run(action.id)).resolves.toMatchObject({ outcome: 'executed' });
    expect(fake.effects).toEqual({ created: 1, updated: 0 });
    expect(await load(action.id)).toMatchObject({ status: 'executed', lastErrorCode: null });
  });
});

describe('execute-action queue (Valkey)', () => {
  const prefix = `test-${randomUUID()}`;
  const connection = { url: env.REDIS_URL, maxRetriesPerRequest: null };
  const queue = new Queue(queueNames.executeAction, { connection, prefix, defaultJobOptions });
  const events = new QueueEvents(queueNames.executeAction, { connection, prefix });
  const queueFake = createFakeProvider();
  const workers = startWorkers({
    connection,
    log,
    prefix,
    db: db.app.db,
    adapters: queueFake.adapters,
    reportError: () => {},
    nango: createFakeNango(),
    testErrors: false,
  });

  afterAll(async () => {
    await workers.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('one job per approval, even when enqueued twice', async () => {
    await events.waitUntilReady();
    const action = await proposeQuote();
    const approved = await approve(action.id);
    const jobId = executeActionJobId(action.id, approved.approvedAt ?? new Date());
    const data = { tenantId: tenant.tenantId, actionId: action.id };
    const job = await queue.add('execute', data, { jobId });
    await queue.add('execute', data, { jobId });
    await expect(job.waitUntilFinished(events, 10_000)).resolves.toMatchObject({
      outcome: 'executed',
    });
    expect(queueFake.calls.filter((c) => c.idempotencyKey === action.idempotencyKey)).toHaveLength(
      1,
    );
  });

  it('retries an outage with backoff, then fails the action with a card', async () => {
    const action = await proposeQuote();
    const approved = await approve(action.id);
    queueFake.failNext(new AdapterError('provider_unavailable', { retryable: true }), 2);
    const job = await queue.add(
      'execute',
      { tenantId: tenant.tenantId, actionId: action.id },
      {
        jobId: executeActionJobId(action.id, approved.approvedAt ?? new Date()),
        attempts: 2,
        backoff: { type: 'fixed', delay: 10 },
      },
    );
    await expect(job.waitUntilFinished(events, 10_000)).resolves.toEqual({
      outcome: 'failed',
      errorCode: 'provider_unavailable',
    });
    expect(await load(action.id)).toMatchObject({ status: 'failed' });
    expect(await failureCards(action.id)).toHaveLength(1);
  });
});
