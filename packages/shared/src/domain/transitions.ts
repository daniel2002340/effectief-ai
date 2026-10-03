import type { ActionStatus, AuditAction, CardStatus, ConnectionStatus } from './status.ts';

// Allowed status transitions (decision #044). Each table has one transition
// function in packages/db that checks these lists, and a database trigger that
// gets the same pairs as arguments; a test compares the two.

type Transitions<S extends string> = { readonly [From in S]: readonly S[] };

/**
 * `expired → active`: re-authorising through Nango keeps the same connection.
 * `revoked` and `purged` are final; connecting again is a new connection.
 */
export const connectionTransitions: Transitions<ConnectionStatus> = {
  active: ['revoked', 'expired'],
  expired: ['active', 'revoked', 'purged'],
  revoked: ['purged'],
  purged: [],
};

export const cardTransitions: Transitions<CardStatus> = {
  open: ['snoozed', 'done', 'dismissed', 'expired'],
  snoozed: ['open', 'done', 'dismissed', 'expired'],
  done: [],
  dismissed: [],
  expired: [],
};

/**
 * `failed → approved`: retry after a new approval. `executed → concept`:
 * editing after execution, which updates the same provider object.
 */
export const actionTransitions: Transitions<ActionStatus> = {
  concept: ['approved', 'rejected'],
  approved: ['executed', 'failed'],
  failed: ['approved'],
  executed: ['concept'],
  rejected: [],
};

export function isAllowedTransition<S extends string>(
  transitions: Transitions<S>,
  from: S,
  to: S,
): boolean {
  return transitions[from].includes(to);
}

/** `from:to` pairs, the form the database trigger receives. */
export function transitionPairs<S extends string>(transitions: Transitions<S>): string[] {
  return (Object.entries(transitions) as [S, readonly S[]][]).flatMap(([from, targets]) =>
    targets.map((to) => `${from}:${to}`),
  );
}

/** The audit action written when a row enters a status. */
export const connectionAuditActions = {
  active: 'connection.reactivated',
  revoked: 'connection.revoked',
  expired: 'connection.expired',
  purged: 'connection.purged',
} as const satisfies Record<ConnectionStatus, AuditAction>;

export const cardAuditActions = {
  open: 'card.reopened',
  snoozed: 'card.snoozed',
  done: 'card.done',
  dismissed: 'card.dismissed',
  expired: 'card.expired',
} as const satisfies Record<CardStatus, AuditAction>;

export const actionAuditActions = {
  concept: 'action.reopened',
  approved: 'action.approved',
  rejected: 'action.rejected',
  executed: 'action.executed',
  failed: 'action.failed',
} as const satisfies Record<ActionStatus, AuditAction>;
