import * as z from 'zod';
import { isInboxMail, isRemoved } from './message.js';

// A page of Gmail history (users.history.list) as the messages to fetch
// again and the records to delete (docs/integrations.md §3.2).

const HistoryMessage = z.object({ id: z.string(), labelIds: z.array(z.string()).optional() });
const HistoryChange = z.object({ message: HistoryMessage });
export const HistoryListSchema = z.object({
  history: z
    .array(
      z.object({
        messagesAdded: z.array(HistoryChange).optional(),
        messagesDeleted: z.array(HistoryChange).optional(),
        labelsAdded: z.array(HistoryChange).optional(),
        labelsRemoved: z.array(HistoryChange).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string(),
});
export type HistoryPage = z.infer<typeof HistoryListSchema>;

/**
 * Whether a deleted message can have a record: it was in the inbox, trash or
 * spam. A draft or sent mail that is deleted (drafts are, while writing) never
 * had one. Without labels we cannot tell, so it goes.
 */
function wasRecorded(labelIds: readonly string[] | undefined): boolean {
  if (!labelIds) return true;
  return labelIds.some((label) => label === 'INBOX' || label === 'TRASH' || label === 'SPAM');
}

/** What a page of history means per message: fetch it again, or delete its record. */
export function changesOf(page: HistoryPage): { fetch: string[]; remove: string[] } {
  // The history is in order; the last change of a message decides.
  const last = new Map<string, 'fetch' | 'remove' | 'skip'>();
  for (const record of page.history ?? []) {
    for (const { message } of record.messagesDeleted ?? []) {
      last.set(message.id, wasRecorded(message.labelIds) ? 'remove' : 'skip');
    }
    const changed = [
      ...(record.messagesAdded ?? []),
      ...(record.labelsAdded ?? []),
      ...(record.labelsRemoved ?? []),
    ];
    for (const { message } of changed) {
      last.set(
        message.id,
        isRemoved(message.labelIds) ? 'remove' : isInboxMail(message.labelIds) ? 'fetch' : 'skip',
      );
    }
  }
  const fetch: string[] = [];
  const remove: string[] = [];
  for (const [id, change] of last) {
    if (change === 'fetch') fetch.push(id);
    if (change === 'remove') remove.push(id);
  }
  return { fetch, remove };
}
