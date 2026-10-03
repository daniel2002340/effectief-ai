import { randomUUID } from 'node:crypto';
import { factTransitions, playbookTransitions, transitionPairs } from '@effectief/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proposeAction, transitionAction } from '../feed/actions.ts';
import { listAuditLog } from '../feed/audit.ts';
import { createTestCard, createTestConnection, replyInput } from '../feed/test-fixtures.ts';
import { createEntity } from '../memory/entities.ts';
import {
  checkViolation,
  openTestDatabases,
  permissionDenied,
  type TestTenant,
} from '../test-support.ts';
import { type TenantTransaction, withTenant } from '../with-tenant.ts';
import { getCompanyProfile, upsertCompanyProfile } from './company-profile.ts';
import {
  addDocumentChunks,
  createDocument,
  getDocument,
  linkDocumentEntity,
  listDocumentChunks,
  listDocumentEntities,
  setDocumentStatus,
} from './documents.ts';
import { listInsights, upsertInsight } from './insights.ts';
import {
  addPlaybookExample,
  confirmPlaybook,
  createPlaybook,
  createPlaybookVersion,
  getPlaybook,
  getPlaybookUsage,
  listPlaybookExamples,
  listPlaybooks,
  rejectPlaybook,
  retirePlaybook,
} from './playbooks.ts';
import { seedKnowledge, sha256 } from './test-fixtures.ts';

const db = openTestDatabases();
let tenant: TestTenant;
let world: Awaited<ReturnType<typeof seedKnowledge>>;
let user: { type: 'user'; userId: string };

beforeAll(async () => {
  tenant = await db.createTenant();
  user = { type: 'user', userId: tenant.userId };
  world = await inTenant((tx) => seedKnowledge(tx, tenant));
});
afterAll(() => db.close());

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(db.app.db, tenant.tenantId, fn);

const integrityViolation = { cause: expect.objectContaining({ code: '23000' }) };

const newPlaybook = (title = 'Offerte dakgoot') =>
  inTenant((tx) =>
    createPlaybook(tx, {
      title,
      triggerDescription: 'Aanvraag voor een nieuwe dakgoot',
      instruction: 'Vraag naar de lengte in meters',
      template: 'Beste {klantnaam}, hoe lang is de dakgoot?',
      scope: { scope: 'company' },
      source: { sourceType: 'system' },
    }),
  );

describe('status transitions of facts and playbooks', () => {
  it('match the arguments of the database triggers', async () => {
    const { rows } = await db.app.db.execute<{ table_name: string; args: string }>(sql`
      select c.relname as table_name, encode(t.tgargs, 'escape') as args
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgname in ('facts_status_guard', 'playbooks_status_guard')
    `);
    const actual = Object.fromEntries(
      rows.map((row) => [row.table_name, row.args.split('\\000').filter(Boolean).sort()]),
    );
    expect(actual).toEqual({
      facts: transitionPairs(factTransitions).sort(),
      playbooks: transitionPairs(playbookTransitions).sort(),
    });
  });

  it('the database refuses transitions outside the lists', async () => {
    // world.fact is confirmed, world.playbook is proposed.
    const forbidden = [
      ['facts', world.fact.id, 'proposed'],
      ['facts', world.fact.id, 'rejected'],
      ['playbooks', world.playbook.id, 'retired'],
    ] as const;
    for (const [table, id, to] of forbidden) {
      await expect(
        inTenant((tx) =>
          tx.execute(
            sql`update ${sql.identifier(table)} set status = ${to}, confirmed_at = now() where id = ${id}`,
          ),
        ),
      ).rejects.toMatchObject(integrityViolation);
    }
  });

  it('a playbook cannot be inserted as confirmed', async () => {
    await expect(
      inTenant((tx) =>
        tx.execute(sql`insert into playbooks (title, trigger_description, instruction, scope, status, confirmed_at, source_type)
                       values ('X', 'X', 'X', 'company', 'confirmed', now(), 'system')`),
      ),
    ).rejects.toMatchObject(integrityViolation);
  });
});

describe('playbooks', () => {
  it('a new playbook is proposed, version 1', async () => {
    const playbook = await newPlaybook();
    expect(playbook).toMatchObject({ status: 'proposed', version: 1, supersedesId: null });
  });

  it('confirming sets who and when, with an audit entry', async () => {
    const playbook = await newPlaybook();
    const { playbook: confirmed, retired } = await inTenant((tx) =>
      confirmPlaybook(tx, { playbookId: playbook.id, actor: user }),
    );
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmedByUserId: tenant.userId });
    expect(retired).toBeUndefined();
    const log = await inTenant((tx) =>
      listAuditLog(tx, { objectType: 'playbooks', objectId: playbook.id }),
    );
    expect(log.map((e) => [e.action, e.metadata])).toEqual([
      ['playbook.confirmed', { scope: 'company', version: 1 }],
    ]);
  });

  it('a new version keeps the scope, and confirming it retires the old one', async () => {
    const v1 = await newPlaybook();
    await inTenant((tx) => confirmPlaybook(tx, { playbookId: v1.id, actor: user }));
    const v2 = await inTenant((tx) =>
      createPlaybookVersion(tx, {
        supersedesId: v1.id,
        title: 'Offerte dakgoot',
        triggerDescription: 'Aanvraag voor een nieuwe dakgoot',
        instruction: 'Vraag naar de lengte en het materiaal',
        source: { sourceType: 'user', sourceUserId: tenant.userId },
      }),
    );
    expect(v2).toMatchObject({
      version: 2,
      supersedesId: v1.id,
      scope: 'company',
      status: 'proposed',
    });
    // Until v2 is confirmed, v1 stays in force.
    expect((await inTenant((tx) => getPlaybook(tx, v1.id)))?.status).toBe('confirmed');

    const { retired } = await inTenant((tx) =>
      confirmPlaybook(tx, { playbookId: v2.id, actor: user }),
    );
    expect(retired).toMatchObject({ id: v1.id, status: 'retired' });
    expect((await inTenant((tx) => getPlaybook(tx, v1.id)))?.instruction).toBe(v1.instruction);
  });

  it('of two competing versions only one can be confirmed', async () => {
    const v1 = await newPlaybook();
    await inTenant((tx) => confirmPlaybook(tx, { playbookId: v1.id, actor: user }));
    const version = (instruction: string) =>
      inTenant((tx) =>
        createPlaybookVersion(tx, {
          supersedesId: v1.id,
          title: 'X',
          triggerDescription: 'X',
          instruction,
          source: { sourceType: 'system' },
        }),
      );
    const a = await version('A');
    const b = await version('B');
    await inTenant((tx) => confirmPlaybook(tx, { playbookId: a.id, actor: user }));
    await expect(
      inTenant((tx) => confirmPlaybook(tx, { playbookId: b.id, actor: user })),
    ).rejects.toMatchObject({ name: 'TransitionError', code: 'status_changed' });
    // The failed confirmation rolled back: b is still proposed.
    expect((await inTenant((tx) => getPlaybook(tx, b.id)))?.status).toBe('proposed');
  });

  it('a version of an unconfirmed playbook is refused', async () => {
    const proposed = await newPlaybook();
    await expect(
      inTenant((tx) =>
        createPlaybookVersion(tx, {
          supersedesId: proposed.id,
          title: 'X',
          triggerDescription: 'X',
          instruction: 'X',
          source: { sourceType: 'system' },
        }),
      ),
    ).rejects.toMatchObject({ name: 'KnowledgeError', code: 'not_current' });
  });

  it('reject and retire', async () => {
    const rejected = await newPlaybook();
    expect(
      (await inTenant((tx) => rejectPlaybook(tx, { playbookId: rejected.id, actor: user }))).status,
    ).toBe('rejected');
    const confirmed = await newPlaybook();
    await inTenant((tx) => confirmPlaybook(tx, { playbookId: confirmed.id, actor: user }));
    expect(
      (await inTenant((tx) => retirePlaybook(tx, { playbookId: confirmed.id, actor: user })))
        .status,
    ).toBe('retired');
    const listed = await inTenant((tx) => listPlaybooks(tx, 'rejected'));
    expect(listed.map((p) => p.id)).toContain(rejected.id);
  });

  it.each([
    ['title', `'X'`],
    ['instruction', `'X'`],
    ['trigger_description', `'X'`],
    ['template', 'null'],
    ['scope', `'company'`],
    ['version', '2'],
    ['supersedes_id', 'null'],
  ])('playbooks.%s cannot be changed', async (column, value) => {
    await expect(
      inTenant((tx) =>
        tx.execute(sql`update playbooks set ${sql.identifier(column)} = ${sql.raw(value)}`),
      ),
    ).rejects.toMatchObject(permissionDenied);
  });

  it('scope columns must match the scope', async () => {
    await expect(
      inTenant((tx) =>
        tx.execute(sql`insert into playbooks (title, trigger_description, instruction, scope, source_type)
                       values ('X', 'X', 'X', 'customer', 'system')`),
      ),
    ).rejects.toMatchObject(checkViolation);
  });

  it('a customer playbook disappears when the customer is forgotten', async () => {
    const { entity, playbook } = await inTenant(async (tx) => {
      const entity = await createEntity(tx, { type: 'contact', name: 'Vergeten' });
      const playbook = await createPlaybook(tx, {
        title: 'X',
        triggerDescription: 'X',
        instruction: 'X',
        scope: { scope: 'customer', scopeEntityId: entity.id },
        source: { sourceType: 'system' },
      });
      return { entity, playbook };
    });
    await inTenant((tx) => tx.execute(sql`delete from entities where id = ${entity.id}`));
    expect(await inTenant((tx) => getPlaybook(tx, playbook.id))).toBeUndefined();
  });

  it('usage counts executed actions that followed the playbook', async () => {
    const playbook = await newPlaybook();
    await inTenant(async (tx) => {
      const connection = await createTestConnection(tx, tenant);
      for (const ordinal of [1, 2]) {
        const card = await createTestCard(tx);
        const { action } = await proposeAction(tx, {
          cardId: card.id,
          connectionId: connection.id,
          type: 'email.reply',
          input: replyInput,
          playbookId: playbook.id,
          ordinal,
          actor: { type: 'agent' },
        });
        if (ordinal === 1) {
          await transitionAction(tx, {
            actionId: action.id,
            from: 'concept',
            to: 'approved',
            actor: user,
          });
          await transitionAction(tx, {
            actionId: action.id,
            from: 'approved',
            to: 'executed',
            providerObjectId: `draft-${action.id}`,
            result: { providerThreadId: 'thread-1' },
            actor: { type: 'system' },
          });
        }
      }
    });
    const usage = await inTenant((tx) => getPlaybookUsage(tx, playbook.id));
    expect(usage?.timesApplied).toBe(1);
    expect(usage?.lastAppliedAt).toBeInstanceOf(Date);
  });
});

describe('playbook_examples', () => {
  it('needs a source and disappears with it', async () => {
    await expect(
      inTenant((tx) =>
        addPlaybookExample(tx, {
          playbookId: world.playbook.id,
          inputExcerpt: 'X',
          outputText: 'Y',
        }),
      ),
    ).rejects.toThrow(/bron/);
    await expect(
      inTenant((tx) =>
        tx.execute(sql`insert into playbook_examples (playbook_id, input_excerpt, output_text)
                       values (${world.playbook.id}, 'X', 'Y')`),
      ),
    ).rejects.toMatchObject(checkViolation);

    expect(await inTenant((tx) => listPlaybookExamples(tx, world.playbook.id))).toHaveLength(1);
    await inTenant((tx) => tx.execute(sql`delete from events where id = ${world.event.id}`));
    expect(await inTenant((tx) => listPlaybookExamples(tx, world.playbook.id))).toEqual([]);
    // Source references elsewhere are cleared, not cascaded: the playbook stays.
    expect(await inTenant((tx) => getPlaybook(tx, world.playbook.id))).toMatchObject({
      sourceType: 'event',
      sourceEventId: null,
    });
  });
});

describe('documents', () => {
  it('the same file twice returns the first document', async () => {
    const hash = sha256(randomUUID());
    const file = {
      origin: 'upload' as const,
      title: 'Prijslijst',
      mimeType: 'application/pdf',
      byteSize: 10,
      sha256: hash.toUpperCase(),
    };
    const first = await inTenant((tx) => createDocument(tx, file));
    const second = await inTenant((tx) => createDocument(tx, { ...file, title: 'Kopie' }));
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, document: { id: first.document.id } });
    expect(first.document).toMatchObject({ sha256: hash, status: 'pending' });
  });

  it('a synced document needs its connection and external id', async () => {
    await expect(
      inTenant((tx) =>
        tx.execute(sql`insert into documents (title, origin, mime_type, byte_size, sha256)
                       values ('X', 'connection', 'text/plain', 1, ${sha256('x')})`),
      ),
    ).rejects.toMatchObject(checkViolation);
    const { document } = await inTenant(async (tx) => {
      const connection = await createTestConnection(tx, tenant);
      return createDocument(tx, {
        origin: 'connection',
        connectionId: connection.id,
        externalId: 'file-1',
        title: 'Offerte.pdf',
        mimeType: 'application/pdf',
        byteSize: 100,
        sha256: sha256(randomUUID()),
      });
    });
    expect(document.externalId).toBe('file-1');
  });

  it('chunks are ordered, unique per ordinal and immutable', async () => {
    const chunks = await inTenant((tx) => listDocumentChunks(tx, world.document.id));
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
    await expect(
      inTenant((tx) =>
        addDocumentChunks(tx, {
          documentId: world.document.id,
          chunks: [{ ordinal: 0, content: 'Dubbel', tokenCount: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
    await expect(
      inTenant((tx) => tx.execute(sql`update document_chunks set content = 'X'`)),
    ).rejects.toMatchObject(permissionDenied);
  });

  it('status and entity links', async () => {
    const updated = await inTenant((tx) => setDocumentStatus(tx, world.document.id, 'ready'));
    expect(updated?.status).toBe('ready');
    expect((await inTenant((tx) => getDocument(tx, world.document.id)))?.status).toBe('ready');
    await inTenant((tx) =>
      linkDocumentEntity(tx, { documentId: world.document.id, entityId: world.entity.id }),
    );
    expect(await inTenant((tx) => listDocumentEntities(tx, world.document.id))).toEqual([
      { entityId: world.entity.id },
    ]);
  });
});

describe('company_profile', () => {
  it('one row per tenant; upserting replaces it', async () => {
    const updated = await inTenant((tx) =>
      upsertCompanyProfile(tx, {
        tradeName: 'Jansen Installatietechniek',
        sector: 'installation',
        kvkNumber: '12345678',
        vatNumber: 'NL123456789B01',
        openingHours: { monday: [{ open: '08:00', close: '17:00' }] },
        details: { websiteUrl: 'https://jansen.example' },
      }),
    );
    expect(updated).toMatchObject({
      tenantId: tenant.tenantId,
      tradeName: 'Jansen Installatietechniek',
      toneOfVoice: null,
      details: { websiteUrl: 'https://jansen.example' },
    });
    const { rows } = await inTenant((tx) =>
      tx.execute(sql`select count(*)::int as n from company_profile`),
    );
    expect(rows).toEqual([{ n: 1 }]);
    expect((await inTenant(getCompanyProfile))?.kvkNumber).toBe('12345678');
  });

  it('validates its fields', async () => {
    for (const input of [
      { tradeName: 'X', sector: 'bakery' },
      { tradeName: 'X', sector: 'other', kvkNumber: '123' },
      {
        tradeName: 'X',
        sector: 'other',
        openingHours: { monday: [{ open: '17:00', close: '08:00' }] },
      },
    ]) {
      // @ts-expect-error: invalid on purpose
      await expect(inTenant((tx) => upsertCompanyProfile(tx, input))).rejects.toThrow();
    }
  });
});

describe('insights', () => {
  it('recomputing is an upsert on kind and entity', async () => {
    const recomputed = await inTenant((tx) =>
      upsertInsight(tx, {
        kind: 'payment_behaviour',
        entityId: world.entity.id,
        payload: { invoiceCount: 5, averageDaysLate: 9.5 },
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
    expect(recomputed.id).toBe(world.insight.id);
    expect(recomputed.payload).toEqual({ invoiceCount: 5, averageDaysLate: 9.5 });
  });

  it('a company-wide insight has no entity and is unique too', async () => {
    const input = {
      kind: 'open_quotes' as const,
      payload: { count: 3, olderThanDays: 14, totalExclVatCents: 360_000 },
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    const first = await inTenant((tx) => upsertInsight(tx, input));
    const second = await inTenant((tx) =>
      upsertInsight(tx, { ...input, payload: { ...input.payload, count: 4 } }),
    );
    expect(second.id).toBe(first.id);
    expect((await inTenant((tx) => listInsights(tx))).map((i) => i.kind)).toEqual(['open_quotes']);
    await expect(
      inTenant((tx) =>
        tx.execute(sql`insert into insights (kind, entity_id, payload, expires_at)
                       values ('open_quotes', ${world.entity.id}, '{}', now() + interval '1 day')`),
      ),
    ).rejects.toMatchObject(checkViolation);
  });

  it('expired insights are not listed', async () => {
    const entity = await inTenant((tx) => createEntity(tx, { type: 'contact', name: 'Laat' }));
    await inTenant((tx) =>
      tx.execute(sql`insert into insights (kind, entity_id, payload, computed_at, expires_at)
                     values ('payment_behaviour', ${entity.id}, '{}', now() - interval '2 days', now() - interval '1 day')`),
    );
    expect(await inTenant((tx) => listInsights(tx, { entityId: entity.id }))).toEqual([]);
  });
});
