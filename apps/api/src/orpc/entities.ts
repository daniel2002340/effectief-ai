import {
  type Database,
  type Event,
  getEntity,
  listEntityIdentifiers,
  listTimeline,
  withTenant,
} from '@effectief/db';
import type { EntityDetail, TimelineEvent } from '@effectief/shared';
import { ORPCError } from '@orpc/server';
import type { SessionContext } from '../auth/auth.ts';

interface CallContext {
  session: SessionContext;
}

/** The timeline shows summaries only; source content stays out of the API. */
export const toTimelineEvent = (event: Event): TimelineEvent => ({
  id: event.id,
  type: event.type,
  source: event.source,
  occurredAt: event.occurredAt,
  summary: event.summary,
});

export function entityHandlers({ appDb }: { appDb: Database }) {
  return {
    /** An entity of the session's tenant with its timeline, newest first. */
    async get(
      { session }: CallContext,
      input: { id: string; before?: Date | undefined; limit: number },
    ): Promise<EntityDetail> {
      const detail = await withTenant(appDb, session.tenantId, async (tx) => {
        const entity = await getEntity(tx, input.id);
        if (!entity) return undefined;
        return {
          entity,
          identifiers: await listEntityIdentifiers(tx, entity.id),
          timeline: await listTimeline(tx, {
            entityId: entity.id,
            limit: input.limit,
            ...(input.before ? { before: input.before } : {}),
          }),
        };
      });
      if (!detail) throw new ORPCError('NOT_FOUND');
      const { entity } = detail;
      return {
        id: entity.id,
        type: entity.type,
        name: entity.name,
        attributes: entity.attributes,
        archivedAt: entity.archivedAt,
        identifiers: detail.identifiers.map(({ kind, value }) => ({ kind, value })),
        timeline: detail.timeline.map(toTimelineEvent),
      };
    },
  };
}
