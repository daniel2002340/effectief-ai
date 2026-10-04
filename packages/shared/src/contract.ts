import { oc } from '@orpc/contract';
import { z } from 'zod';
import { vatRateBpsSchema } from './domain/money.ts';
import {
  actionErrorCodes,
  actionStatuses,
  actionTypes,
  cardKinds,
  cardStatuses,
  entityTypes,
  eventSources,
  eventTypes,
  identifierKinds,
} from './domain/status.ts';

// The contract describes shapes only. Who may call a procedure is decided in
// the API: procedures require a session unless implemented as publicProcedure.

export const systemStatusOutputSchema = z.object({
  status: z.literal('ok'),
});

export const currentTenantSchema = z.object({
  name: z.string(),
  defaultVatRateBps: vatRateBpsSchema,
});
export type CurrentTenant = z.infer<typeof currentTenantSchema>;

export const updateTenantSettingsInputSchema = z.object({
  defaultVatRateBps: vatRateBpsSchema,
});

/** What the UI gets back about an action; no input, which can hold personal data. */
export const actionSummarySchema = z.object({
  id: z.uuid(),
  cardId: z.uuid(),
  type: z.enum(actionTypes),
  status: z.enum(actionStatuses),
  approvedAt: z.date().nullable(),
  executedAt: z.date().nullable(),
  lastErrorCode: z.enum(actionErrorCodes).nullable(),
});
export type ActionSummary = z.infer<typeof actionSummarySchema>;

/**
 * Approve a concept (optionally with the edited input) or retry a failed
 * action. The input is checked against the schema of the action's type.
 */
export const approveActionInputSchema = z.object({
  actionId: z.uuid(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export const rejectActionInputSchema = z.object({
  actionId: z.uuid(),
});

/** A card in the feed: what it is about, not the source content. */
export const cardSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(cardKinds),
  status: z.enum(cardStatuses),
  title: z.string(),
  summary: z.string().nullable(),
  priority: z.int(),
  snoozedUntil: z.date().nullable(),
  createdAt: z.date(),
});
export type CardSummary = z.infer<typeof cardSummarySchema>;

export const listCardsInputSchema = z.object({
  status: z.enum(['open', 'snoozed']).default('open'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** An event on the timeline: its summary stays after the source content has gone. */
export const timelineEventSchema = z.object({
  id: z.uuid(),
  type: z.enum(eventTypes),
  source: z.enum(eventSources),
  occurredAt: z.date(),
  summary: z.string().nullable(),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const entityRefSchema = z.object({
  id: z.uuid(),
  type: z.enum(entityTypes),
  name: z.string(),
});

/**
 * An action with the input the user approves: shown on the card so the user
 * sees what will be sent. Null once retention cleared it.
 */
export const actionDetailSchema = actionSummarySchema.extend({
  input: z.record(z.string(), z.unknown()).nullable(),
});
export type ActionDetail = z.infer<typeof actionDetailSchema>;

export const cardDetailSchema = cardSummarySchema.extend({
  payload: z.record(z.string(), z.unknown()),
  resolvedAt: z.date().nullable(),
  events: z.array(timelineEventSchema),
  entities: z.array(entityRefSchema),
  actions: z.array(actionDetailSchema),
});
export type CardDetail = z.infer<typeof cardDetailSchema>;

export const getByIdInputSchema = z.object({ id: z.uuid() });

export const getEntityInputSchema = z.object({
  id: z.uuid(),
  /** Timeline page: only events that happened before this moment. */
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const entityDetailSchema = entityRefSchema.extend({
  attributes: z.record(z.string(), z.unknown()),
  archivedAt: z.date().nullable(),
  identifiers: z.array(z.object({ kind: z.enum(identifierKinds), value: z.string() })),
  /** Newest first. */
  timeline: z.array(timelineEventSchema),
});
export type EntityDetail = z.infer<typeof entityDetailSchema>;

export const contract = {
  system: {
    status: oc.route({ method: 'GET', path: '/system/status' }).output(systemStatusOutputSchema),
  },
  tenant: {
    /** The tenant of the session: its name and settings. */
    current: oc.route({ method: 'GET', path: '/tenant' }).output(currentTenantSchema),
    updateSettings: oc
      .route({ method: 'POST', path: '/tenant/settings' })
      .input(updateTenantSettingsInputSchema)
      .output(currentTenantSchema),
  },
  actions: {
    /** Approves; executing follows in the worker. */
    approve: oc
      .route({ method: 'POST', path: '/actions/approve' })
      .input(approveActionInputSchema)
      .output(actionSummarySchema),
    reject: oc
      .route({ method: 'POST', path: '/actions/reject' })
      .input(rejectActionInputSchema)
      .output(actionSummarySchema),
  },
  cards: {
    /** The feed: open (or snoozed) cards, most important and newest first. */
    list: oc
      .route({ method: 'GET', path: '/cards' })
      .input(listCardsInputSchema)
      .output(z.array(cardSummarySchema)),
    get: oc
      .route({ method: 'GET', path: '/cards/{id}' })
      .input(getByIdInputSchema)
      .output(cardDetailSchema),
  },
  entities: {
    /** A contact, company or project with its timeline. */
    get: oc
      .route({ method: 'GET', path: '/entities/{id}' })
      .input(getEntityInputSchema)
      .output(entityDetailSchema),
  },
};

export type Contract = typeof contract;
