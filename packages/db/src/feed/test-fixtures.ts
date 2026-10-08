import { randomUUID } from 'node:crypto';
import type { ActionInput } from '@effectief/shared';
import { createEntity } from '../memory/entities.ts';
import { recordEvent } from '../memory/events.ts';
import type { TestTenant } from '../test-support.ts';
import type { TenantTransaction } from '../with-tenant.ts';
import { proposeAction } from './actions.ts';
import { createCard } from './cards.ts';
import { createConnection } from './connections.ts';

// Test data for the feed tables: a mailbox and a Moneybird connection, a
// contact, a mail event, a card about it and a proposed reply.

export const replyInput: ActionInput<'email.reply'> = {
  to: ['jan@example.test'],
  cc: [],
  subject: 'Re: Offerte',
  bodyText: 'Beste Jan, in de bijlage vindt u de offerte.',
  inReplyToMessageId: 'msg-1',
};

export const quoteInput: ActionInput<'moneybird.quote'> = {
  providerContactId: 'contact-1',
  lines: [
    {
      description: 'Cv-ketel vervangen',
      quantity: '1',
      unitPriceExclVatCents: 185_000,
      vatRateBps: 2100,
    },
  ],
};

export const agent = { type: 'agent' } as const;
export const system = { type: 'system' } as const;
export const asUser = (userId: string) => ({ type: 'user', userId }) as const;

export function createTestConnection(
  tx: TenantTransaction,
  { userId }: TestTenant,
  provider: 'gmail' | 'outlook' | 'moneybird' = 'gmail',
) {
  return createConnection(tx, {
    provider,
    nangoIntegrationId: provider === 'gmail' ? 'google-mail' : provider,
    nangoConnectionId: `conn-${randomUUID()}`,
    externalAccountId: `account-${randomUUID()}`,
    accountLabel: 'info@bedrijf.example',
    connectedByUserId: userId,
    actor: asUser(userId),
  });
}

export async function createTestCard(tx: TenantTransaction, links: { eventIds?: string[] } = {}) {
  const { card } = await createCard(tx, {
    kind: 'email_reply',
    title: 'Jan vraagt om een offerte',
    payload: {},
    dedupeKey: `thread:${randomUUID()}`,
    eventIds: links.eventIds ?? [],
    actor: agent,
  });
  return card;
}

export async function seedFeed(tx: TenantTransaction, tenant: TestTenant) {
  const connection = await createTestConnection(tx, tenant);
  const contact = await createEntity(tx, { type: 'contact', name: 'Jan Jansen' });
  const { event } = await recordEvent(tx, {
    event: {
      source: 'gmail',
      externalId: `message-${randomUUID()}`,
      type: 'email.received',
      occurredAt: new Date(),
      connectionId: connection.id,
      payload: {},
    },
  });
  const { card } = await createCard(tx, {
    kind: 'email_reply',
    title: 'Jan vraagt om een offerte',
    payload: {},
    dedupeKey: `thread:${randomUUID()}`,
    eventIds: [event.id],
    entityIds: [contact.id],
    actor: agent,
  });
  const { action } = await proposeAction(tx, {
    cardId: card.id,
    connectionId: connection.id,
    type: 'email.reply',
    input: replyInput,
    actor: agent,
  });
  return { connection, contact, event, card, action };
}
