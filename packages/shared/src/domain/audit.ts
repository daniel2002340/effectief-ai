import { z } from 'zod';
import {
  type AuditAction,
  actionErrorCodes,
  actionTypes,
  auditActions,
  auditObjectTypes,
  cardKinds,
  connectionProviders,
  connectionStatusReasons,
  playbookScopes,
  retentionSteps,
} from './status.ts';

// audit_log: append-only, and it survives every deletion, so it holds no
// personal data. Metadata per action allows only IDs, codes, counts and enums;
// no schema here accepts free text (decision #040).

/** A code or an ID at a provider; no spaces, so no sentences. */
export const auditCodeSchema = z.string().regex(/^[\w.:/#-]{1,128}$/);

/** Who did it. Only a `user` can approve; the agent only proposes (CLAUDE.md, AI). */
export const actorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('user'), userId: z.uuid() }),
  z.strictObject({ type: z.literal('agent') }),
  z.strictObject({ type: z.literal('system') }),
]);
export type Actor = z.infer<typeof actorSchema>;

/** Correlation with logs; ids only. */
export const auditContextSchema = z.strictObject({
  requestId: auditCodeSchema.optional(),
  jobId: auditCodeSchema.optional(),
});
export type AuditContext = z.infer<typeof auditContextSchema>;

const count = z.int().min(0);

const connectionMetadata = z.strictObject({
  provider: z.enum(connectionProviders),
  reason: z.enum(connectionStatusReasons).optional(),
});

/** Purging a connection: how many rows of its data were deleted. */
export const connectionPurgeCountsSchema = z.strictObject({
  events: count,
  externalRefs: count,
  documents: count,
  cards: count,
  entities: count,
});
export type ConnectionPurgeCounts = z.infer<typeof connectionPurgeCountsSchema>;

const connectionPurgedMetadata = connectionMetadata.extend({
  deleted: connectionPurgeCountsSchema.optional(),
});

const cardMetadata = z.strictObject({ kind: z.enum(cardKinds) });

const actionMetadata = z.strictObject({
  type: z.enum(actionTypes),
  cardId: z.uuid(),
  providerObjectId: auditCodeSchema.optional(),
  errorCode: z.enum(actionErrorCodes).optional(),
  attempts: z.int().min(0).optional(),
});

const factMetadata = z.strictObject({ entityId: z.uuid() });

/** On the old fact: which fact replaced it. */
const factSupersededMetadata = z.strictObject({
  entityId: z.uuid(),
  supersededById: z.uuid(),
});

const playbookMetadata = z.strictObject({
  scope: z.enum(playbookScopes),
  version: z.int().min(1),
});

/** Forgetting a person: counts only, never the name or identifiers (§6.3). */
const entityForgottenMetadata = z.strictObject({
  deleted: z.strictObject({
    entities: count,
    events: count,
    cards: count,
    tasks: count,
  }),
});

/** One retention step and how many rows it deleted or cleared (#037). */
const retentionPurgedMetadata = z.strictObject({
  step: z.enum(retentionSteps),
  count,
});

export const auditMetadataSchemas = {
  'connection.created': connectionMetadata,
  'connection.reactivated': connectionMetadata,
  'connection.revoked': connectionMetadata,
  'connection.expired': connectionMetadata,
  'connection.purged': connectionPurgedMetadata,
  'card.created': cardMetadata,
  'card.reopened': cardMetadata,
  'card.snoozed': cardMetadata,
  'card.done': cardMetadata,
  'card.dismissed': cardMetadata,
  'card.expired': cardMetadata,
  'action.proposed': actionMetadata,
  'action.approved': actionMetadata,
  'action.started': actionMetadata,
  'action.rejected': actionMetadata,
  'action.executed': actionMetadata,
  'action.failed': actionMetadata,
  'action.reopened': actionMetadata,
  'fact.confirmed': factMetadata,
  'fact.rejected': factMetadata,
  'fact.superseded': factSupersededMetadata,
  'playbook.confirmed': playbookMetadata,
  'playbook.rejected': playbookMetadata,
  'playbook.retired': playbookMetadata,
  'entity.forgotten': entityForgottenMetadata,
  'retention.purged': retentionPurgedMetadata,
} satisfies Record<AuditAction, z.ZodType>;

export type AuditMetadata<A extends AuditAction = AuditAction> = z.infer<
  (typeof auditMetadataSchemas)[A]
>;

export const auditEntrySchema = z
  .strictObject({
    actor: actorSchema,
    action: z.enum(auditActions),
    objectType: z.enum(auditObjectTypes),
    objectId: z.uuid().nullable(),
    fromStatus: auditCodeSchema.nullish(),
    toStatus: auditCodeSchema.nullish(),
    metadata: z.record(z.string(), z.unknown()),
    context: auditContextSchema.default({}),
  })
  .transform((entry, ctx) => {
    const metadata = auditMetadataSchemas[entry.action].safeParse(entry.metadata);
    if (!metadata.success) {
      for (const issue of metadata.error.issues) {
        ctx.addIssue({ ...issue, path: ['metadata', ...issue.path] });
      }
      return z.NEVER;
    }
    return { ...entry, metadata: metadata.data };
  });
export type AuditEntryInput = z.input<typeof auditEntrySchema>;
