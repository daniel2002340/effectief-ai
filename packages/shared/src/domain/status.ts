// Closed lists for text columns with a check constraint (decision #035).
// Each list feeds the Zod schema, the TypeScript type and the database check,
// so they cannot drift apart. Changing a list needs a migration.

export const entityTypes = ['contact', 'company', 'project'] as const;
export type EntityType = (typeof entityTypes)[number];

export const identifierKinds = ['email', 'phone', 'email_domain', 'kvk'] as const;
export type IdentifierKind = (typeof identifierKinds)[number];

export const relationTypes = ['works_at', 'contact_for', 'client_of', 'part_of'] as const;
export type RelationType = (typeof relationTypes)[number];

/** AI knowledge: the model only writes `proposed`; only a user confirms. */
export const knowledgeStatuses = ['proposed', 'confirmed', 'rejected'] as const;
export type KnowledgeStatus = (typeof knowledgeStatuses)[number];

export const eventSources = ['gmail', 'outlook', 'moneybird', 'mollie', 'app'] as const;
export type EventSource = (typeof eventSources)[number];

export const eventTypes = [
  'email.received',
  'email.sent',
  'quote.sent',
  'quote.accepted',
  'invoice.sent',
  'payment.paid',
  'payment.failed',
  'action.executed',
  'note.added',
] as const;
export type EventType = (typeof eventTypes)[number];

export const eventEntityRoles = ['sender', 'recipient', 'subject', 'mentioned'] as const;
export type EventEntityRole = (typeof eventEntityRoles)[number];

export const linkedByValues = ['rule', 'ai', 'user'] as const;
export type LinkedBy = (typeof linkedByValues)[number];

export const taskStatuses = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskCreatedByValues = ['ai', 'user'] as const;
export type TaskCreatedBy = (typeof taskCreatedByValues)[number];

/** Where a piece of knowledge came from (docs/data-model.md §3.6). */
export const sourceTypes = ['event', 'document', 'user', 'action', 'system'] as const;
export type SourceType = (typeof sourceTypes)[number];
