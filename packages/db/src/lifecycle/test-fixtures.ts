import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { proposeAction } from '../feed/actions.ts';
import { createCard } from '../feed/cards.ts';
import { addEntityExternalRef } from '../feed/connections.ts';
import { agent, asUser, createTestConnection } from '../feed/test-fixtures.ts';
import { createDocument, linkDocumentEntity } from '../knowledge/documents.ts';
import { storeEmbedding } from '../knowledge/embeddings.ts';
import { confirmFact, createFact } from '../knowledge/facts.ts';
import { upsertInsight } from '../knowledge/insights.ts';
import { addPlaybookExample, createPlaybook } from '../knowledge/playbooks.ts';
import { documentVersion, model, randomVector, sha256 } from '../knowledge/test-fixtures.ts';
import { addEntityIdentifier, createEntity } from '../memory/entities.ts';
import { linkEventEntity, recordEvent, setEventSummary } from '../memory/events.ts';
import { createRelation } from '../memory/relations.ts';
import { createTask } from '../memory/tasks.ts';
import { entities } from '../schema/index.ts';
import type { TestTenant } from '../test-support.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// A person with a trace in every table that can hold personal data about
// them, plus a company and a document that must survive when they are
// forgotten. Every free-text field about the person contains `marker`, so a
// test can search all tables for it.

export function personMarkers() {
  const marker = `Vergeet${randomUUID().replaceAll('-', '')}`;
  return { marker, email: `${marker.toLowerCase()}@example.test`, phone: '+31612345678' };
}

export async function seedPerson(
  tx: TenantTransaction,
  tenant: TestTenant,
  { marker, email, phone }: ReturnType<typeof personMarkers>,
  seed = 1,
) {
  const user = asUser(tenant.userId);
  const gmail = await createTestConnection(tx, tenant);
  const moneybird = await createTestConnection(tx, tenant, 'moneybird');

  const person = await createEntity(tx, { type: 'contact', name: `Jan ${marker}` });
  const duplicate = await createEntity(tx, { type: 'contact', name: `J. ${marker}` });
  await tx.update(entities).set({ mergedIntoId: person.id }).where(eq(entities.id, duplicate.id));
  const company = await createEntity(tx, { type: 'company', name: 'Bouwbedrijf De Vries' });

  await addEntityIdentifier(tx, {
    entityId: person.id,
    identifier: { kind: 'email', value: email },
    source: { sourceType: 'system' },
  });
  await addEntityIdentifier(tx, {
    entityId: duplicate.id,
    identifier: { kind: 'phone', value: phone },
    source: { sourceType: 'user', sourceUserId: tenant.userId },
  });
  await addEntityExternalRef(tx, {
    entityId: person.id,
    connectionId: moneybird.id,
    objectType: 'contact',
    externalId: `contact-${randomUUID()}`,
  });
  await createRelation(tx, {
    fromEntityId: person.id,
    toEntityId: company.id,
    type: 'works_at',
    source: { sourceType: 'system' },
  });

  const { event: mail } = await recordEvent(tx, {
    event: {
      source: 'gmail',
      externalId: `message-${randomUUID()}`,
      type: 'email.received',
      occurredAt: new Date(),
      threadKey: `thread-${randomUUID()}`,
      connectionId: gmail.id,
      payload: {},
    },
    content: {
      fromAddress: email,
      toAddresses: ['info@bedrijf.example'],
      subject: `Offerte voor ${marker}`,
      bodyText: `Groeten, Jan ${marker}, ${phone}`,
    },
  });
  await setEventSummary(tx, mail.id, `Jan ${marker} vraagt een offerte`);
  await linkEventEntity(tx, {
    eventId: mail.id,
    entityId: person.id,
    role: 'sender',
    linkedBy: 'rule',
  });
  // Also about the company; it goes with the person's mail.
  await linkEventEntity(tx, {
    eventId: mail.id,
    entityId: company.id,
    role: 'mentioned',
    linkedBy: 'ai',
  });
  // An event about the company only, which must stay.
  const { event: companyMail } = await recordEvent(tx, {
    event: {
      source: 'gmail',
      externalId: `message-${randomUUID()}`,
      type: 'email.received',
      occurredAt: new Date(),
      connectionId: gmail.id,
      payload: {},
    },
  });
  await linkEventEntity(tx, {
    eventId: companyMail.id,
    entityId: company.id,
    role: 'sender',
    linkedBy: 'rule',
  });

  const { card } = await createCard(tx, {
    kind: 'email_reply',
    title: `Jan ${marker} vraagt om een offerte`,
    summary: `Antwoord aan ${email}`,
    payload: { suggestedTask: { title: `${marker} terugbellen` } },
    dedupeKey: `thread:${mail.threadKey}`,
    eventIds: [mail.id],
    entityIds: [person.id],
    actor: agent,
  });
  const { action } = await proposeAction(tx, {
    cardId: card.id,
    connectionId: gmail.id,
    type: 'email.reply',
    input: {
      to: [email],
      cc: [],
      subject: `Re: Offerte voor ${marker}`,
      bodyText: `Beste Jan ${marker}, hierbij de offerte.`,
      inReplyToMessageId: 'msg-1',
    },
    actor: agent,
  });
  // A card linked only through the duplicate.
  const { card: duplicateCard } = await createCard(tx, {
    kind: 'quote_request',
    title: `${marker} wil een warmtepomp`,
    payload: {},
    entityIds: [duplicate.id],
    actor: agent,
  });

  const { task } = await createTask(tx, {
    title: `${marker} vrijdag bellen`,
    createdBy: 'user',
    entityIds: [person.id],
    source: { sourceType: 'user', sourceUserId: tenant.userId },
  });
  const { card: taskCard } = await createCard(tx, {
    kind: 'task_due',
    title: `Bellen: ${marker}`,
    payload: {},
    taskId: task.id,
    actor: { type: 'system' },
  });

  const proposed = await createFact(tx, {
    entityId: person.id,
    statement: `${marker} wil ’s ochtends gebeld worden`,
    attribute: 'preferred_contact_time',
    source: { sourceType: 'event', sourceEventId: mail.id },
  });
  const { fact } = await confirmFact(tx, { factId: proposed.id, actor: user });
  const factVector = randomVector(seed);
  await storeEmbedding(tx, 'fact', {
    ownerId: fact.id,
    model,
    modelVersion: documentVersion,
    embedding: factVector,
  });
  // A fact about the company, sourced from the person's mail: it stays, its
  // source reference becomes null.
  const companyFact = await createFact(tx, {
    entityId: company.id,
    statement: 'Werkt alleen op werkdagen',
    source: { sourceType: 'event', sourceEventId: mail.id },
  });

  const playbook = await createPlaybook(tx, {
    title: 'Offerte warmtepomp',
    triggerDescription: `Aanvraag van ${marker}`,
    instruction: `Noem ${marker} altijd bij de voornaam`,
    scope: { scope: 'customer', scopeEntityId: person.id },
    source: { sourceType: 'event', sourceEventId: mail.id },
  });
  const playbookVector = randomVector(seed + 1);
  await storeEmbedding(tx, 'playbook', {
    ownerId: playbook.id,
    model,
    modelVersion: documentVersion,
    embedding: playbookVector,
  });
  await addPlaybookExample(tx, {
    playbookId: playbook.id,
    sourceEventId: mail.id,
    inputExcerpt: `Offerte voor ${marker}`,
    outputText: `Beste ${marker}`,
  });

  await upsertInsight(tx, {
    kind: 'payment_behaviour',
    entityId: person.id,
    payload: { invoiceCount: 3, averageDaysLate: 9 },
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const { document } = await createDocument(tx, {
    origin: 'upload',
    title: 'Algemene voorwaarden',
    mimeType: 'application/pdf',
    byteSize: 100,
    sha256: sha256(randomUUID()),
    uploadedByUserId: tenant.userId,
  });
  await linkDocumentEntity(tx, { documentId: document.id, entityId: person.id });

  return {
    gmail,
    moneybird,
    person,
    duplicate,
    company,
    mail,
    companyMail,
    card,
    action,
    duplicateCard,
    task,
    taskCard,
    fact,
    factVector,
    companyFact,
    playbook,
    playbookVector,
    document,
  };
}

/** Rows (as text) in every tenant table that contain `needle`, per table. */
export async function findEverywhere(tx: TenantTransaction, needle: string, except: string[] = []) {
  const { rows: tables } = await tx.execute<{ table_name: string }>(sql`
    select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (select from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
     order by 1
  `);
  const found: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    if (except.includes(table)) continue;
    const { rows } = await tx.execute<{ count: number }>(sql`
      select count(*)::int as count from ${sql.identifier(table)} t
       where t::text ilike ${`%${needle}%`}
    `);
    const count = rows[0]?.count ?? 0;
    if (count > 0) found[table] = count;
  }
  return { tables: tables.map((row) => row.table_name), found };
}
