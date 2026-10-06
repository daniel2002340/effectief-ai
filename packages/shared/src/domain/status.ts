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

export const connectionProviders = ['gmail', 'outlook', 'moneybird', 'mollie'] as const;
export type ConnectionProvider = (typeof connectionProviders)[number];

export const connectionStatuses = ['active', 'revoked', 'expired', 'purged'] as const;
export type ConnectionStatus = (typeof connectionStatuses)[number];

/** Why a connection changed status; a code, never a provider error message. */
export const connectionStatusReasons = [
  'invalid_grant',
  'provider_revoked',
  'user_disconnected',
  'reauthorized',
  'data_purged',
  /** A refresh failed earlier and works again (Nango's recovery webhook). */
  'auth_recovered',
  /** After re-authorizing, the provider account is not the one connected first. */
  'account_mismatch',
] as const;
export type ConnectionStatusReason = (typeof connectionStatusReasons)[number];

/**
 * Why a connect attempt did not become a connection (docs/integrations.md §2):
 * the mailbox is already connected in this tenant, a check failed (tags,
 * integration, membership), or it was not completed within a day.
 */
export const connectAttemptFailureCodes = ['duplicate_account', 'rejected', 'expired'] as const;
export type ConnectAttemptFailureCode = (typeof connectAttemptFailureCodes)[number];

export const cardKinds = [
  'email_reply',
  'quote_request',
  'payment_overdue',
  'connection_problem',
  'knowledge_review',
  'task_due',
  'insight',
  'action_failed',
] as const;
export type CardKind = (typeof cardKinds)[number];

export const cardStatuses = ['open', 'snoozed', 'done', 'dismissed', 'expired'] as const;
export type CardStatus = (typeof cardStatuses)[number];

export const actionTypes = [
  'email.reply',
  'moneybird.quote',
  'moneybird.invoice_reminder',
  'mollie.payment_link',
] as const;
export type ActionType = (typeof actionTypes)[number];

/** `executing`: claimed by one execute job, which is calling the provider. */
export const actionStatuses = [
  'concept',
  'approved',
  'executing',
  'executed',
  'failed',
  'rejected',
] as const;
export type ActionStatus = (typeof actionStatuses)[number];

/**
 * Why executing an action failed; a code, never a provider error message
 * (those can hold personal data). The UI shows a Dutch text per code.
 */
export const actionErrorCodes = [
  /** Provider down or timing out; retried. */
  'provider_unavailable',
  /** Too many requests; retried. */
  'rate_limited',
  /** The grant is no longer valid: the connection expires, no retries. */
  'auth_expired',
  /** The connection is not active (anymore). */
  'connection_inactive',
  /** The provider refused the input. */
  'rejected_by_provider',
  /** The provider object to update no longer exists. */
  'provider_object_missing',
  /** The stored input no longer passes its schema, or was purged. */
  'invalid_input',
  /** No adapter for this provider and action type. */
  'unsupported',
  'unknown',
] as const;
export type ActionErrorCode = (typeof actionErrorCodes)[number];

/** Who did something: a person, the AI, or the system (jobs, retention). */
export const actorTypes = ['user', 'agent', 'system'] as const;
export type ActorType = (typeof actorTypes)[number];

export const auditObjectTypes = [
  'connections',
  'cards',
  'actions',
  'facts',
  'playbooks',
  'entities',
  'event_contents',
  'webhook_deliveries',
  'connect_attempts',
] as const;
export type AuditObjectType = (typeof auditObjectTypes)[number];

export const auditActions = [
  'connection.created',
  'connection.reactivated',
  'connection.revoked',
  'connection.expired',
  'connection.purged',
  /** Re-authorized while still active: same account, no status change. */
  'connection.reauthorized',
  'connect_attempt.rejected',
  'card.created',
  'card.reopened',
  'card.snoozed',
  'card.done',
  'card.dismissed',
  'card.expired',
  'action.proposed',
  'action.approved',
  'action.started',
  'action.rejected',
  'action.executed',
  'action.failed',
  'action.reopened',
  'fact.confirmed',
  'fact.rejected',
  'fact.superseded',
  'playbook.confirmed',
  'playbook.rejected',
  'playbook.retired',
  'entity.forgotten',
  'retention.purged',
] as const;
export type AuditAction = (typeof auditActions)[number];

/**
 * What the retention job removes (docs/data-model.md, event_contents):
 * expired source content, inputs of long-finished actions, long-closed cards,
 * processed webhook deliveries.
 */
export const retentionSteps = [
  'event_contents',
  'action_inputs',
  'closed_cards',
  'webhook_deliveries',
  'connect_attempts',
] as const;
export type RetentionStep = (typeof retentionSteps)[number];

/** `retired`: replaced by a newer version or withdrawn by the user. */
export const playbookStatuses = ['proposed', 'confirmed', 'rejected', 'retired'] as const;
export type PlaybookStatus = (typeof playbookStatuses)[number];

export const playbookScopes = ['company', 'user', 'customer'] as const;
export type PlaybookScope = (typeof playbookScopes)[number];

export const documentOrigins = ['upload', 'connection'] as const;
export type DocumentOrigin = (typeof documentOrigins)[number];

export const documentStatuses = ['pending', 'processing', 'ready', 'failed'] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

export const companySectors = [
  'installation',
  'construction',
  'gardening',
  'cleaning',
  'events',
  'photography',
  'business_services',
  'other',
] as const;
export type CompanySector = (typeof companySectors)[number];

export const insightKinds = ['open_quotes', 'payment_behaviour'] as const;
export type InsightKind = (typeof insightKinds)[number];
