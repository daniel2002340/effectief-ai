import { randomUUID } from 'node:crypto';
import { parseEnv } from '@effectief/shared';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationEnvSchema } from '../env.ts';
import {
  checkViolation,
  openTestDatabases,
  permissionDenied,
  type TestTenant,
} from '../test-support.ts';
import { withTenant } from '../with-tenant.ts';
import { writeAudit } from './audit.ts';
import { agent, seedFeed, system } from './test-fixtures.ts';

// audit_log is append-only: the app role has no UPDATE, DELETE or TRUNCATE
// privilege, and a trigger refuses UPDATE, DELETE and TRUNCATE for every role,
// including the owner. Only the cascade from deleting a tenant removes rows.

const db = openTestDatabases();
// The owner (migration role) only to prove the trigger also binds it.
const owner = new pg.Pool({
  connectionString: parseEnv(migrationEnvSchema, process.env).DATABASE_MIGRATION_URL,
  max: 1,
});
let tenant: TestTenant;
let entryId: string;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db.app.db, tenant.tenantId, fn);

beforeAll(async () => {
  tenant = await db.createTenant();
  await inTenant((tx) => seedFeed(tx, tenant));
  const entry = await inTenant((tx) =>
    writeAudit(tx, {
      actor: system,
      action: 'card.expired',
      objectType: 'cards',
      objectId: randomUUID(),
      metadata: { kind: 'insight' },
      context: { jobId: 'job-1' },
    }),
  );
  entryId = entry.id;
});

afterAll(async () => {
  await owner.end();
  await db.close();
});

describe('audit_log for the app role', () => {
  it.each([
    ['update', sql`update audit_log set to_status = 'x'`],
    ['delete', sql`delete from audit_log`],
    ['truncate', sql`truncate audit_log`],
  ])('cannot %s, also not its own rows', async (_name, statement) => {
    await expect(inTenant((tx) => tx.execute(statement))).rejects.toMatchObject(permissionDenied);
  });

  it('keeps every entry', async () => {
    const { rows } = await inTenant((tx) =>
      tx.execute(sql`select count(*)::int as n from audit_log where id = ${entryId}`),
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

describe('audit_log for the owner', () => {
  const integrityViolation = expect.objectContaining({ code: '23000' });

  it.each([
    ['update', `update audit_log set to_status = 'x' where id = $1`],
    ['delete', 'delete from audit_log where id = $1'],
  ])('cannot %s', async (_name, statement) => {
    await expect(owner.query(statement, [entryId])).rejects.toEqual(integrityViolation);
  });

  it('cannot truncate', async () => {
    await expect(owner.query('truncate audit_log')).rejects.toEqual(integrityViolation);
  });
});

describe('deleting a tenant', () => {
  it('removes its audit entries through the cascade', async () => {
    const leaving = await db.createTenant();
    const count = () =>
      withTenant(db.app.db, leaving.tenantId, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log`),
      );
    await withTenant(db.app.db, leaving.tenantId, (tx) => seedFeed(tx, leaving));
    expect((await count()).rows[0]?.n).toBeGreaterThan(0);

    await db.authPool.query('delete from organization where id = $1', [leaving.tenantId]);
    expect((await count()).rows).toEqual([{ n: 0 }]);
  });
});

describe('audit entries hold no personal data', () => {
  it('metadata with free text is refused', async () => {
    await expect(
      inTenant((tx) =>
        writeAudit(tx, {
          actor: agent,
          action: 'card.created',
          objectType: 'cards',
          objectId: randomUUID(),
          metadata: { kind: 'email_reply', title: 'Jan Jansen vraagt om een offerte' },
        }),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      inTenant((tx) =>
        writeAudit(tx, {
          actor: system,
          action: 'action.failed',
          objectType: 'actions',
          objectId: randomUUID(),
          metadata: { type: 'email.reply', cardId: randomUUID(), errorCode: 'Mailbox van jan vol' },
        }),
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('a user actor needs a user id, and only a user actor has one', async () => {
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`insert into audit_log (actor_type, action, object_type, metadata)
              values ('user', 'card.created', 'cards', '{"kind":"insight"}')`,
        ),
      ),
    ).rejects.toMatchObject(checkViolation);
    await expect(
      inTenant((tx) =>
        tx.execute(
          sql`insert into audit_log (actor_type, actor_user_id, action, object_type, metadata)
              values ('agent', ${tenant.userId}, 'card.created', 'cards', '{"kind":"insight"}')`,
        ),
      ),
    ).rejects.toMatchObject(checkViolation);
  });
});
