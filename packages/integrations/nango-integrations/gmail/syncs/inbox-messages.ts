import { createSync } from 'nango';
import * as z from 'zod';
import { changesOf, HistoryListSchema, type HistoryPage } from '../helpers/history.js';
import {
  GmailMessage,
  InboxMessage,
  isInboxMail,
  isRemoved,
  toInboxMessage,
} from '../helpers/message.js';
import { patiently } from '../helpers/rate-limit.js';

// New mail in the Gmail inbox (docs/integrations.md §3.1–§3.2, decision #074).
//
// Change source: the History API from a saved historyId, like Nango's template.
// The first run lists the inbox of the last 14 days (backfill), after saving
// the profile's historyId so the switch to history misses nothing.
// Checkpoint: { phase, historyId, pageToken? }. In `backfill` the pageToken
// resumes messages.list; in `history` historyId + pageToken resume
// history.list, and after the last page the response's historyId is the new
// start. Only changed messages are fetched.
// Deletes: explicit, from the history (deleted, or moved to trash or spam) →
// batchDelete. No trackDeletes: the history returns changes only. Archiving
// (leaving the inbox) changes nothing; the mail still exists.

const BACKFILL_QUERY = 'in:inbox newer_than:14d -category:promotions -category:social';
const PAGE_SIZE = 100;
/** Parallel messages.get calls (5 quota units each). */
const CONCURRENCY = 5;
/**
 * Each batch takes at least this long: 5 calls per 500 ms is at most 3,000
 * units a minute. Nango's Google app allows 6,000 per user, yet dry runs on
 * staging hit its limit after ~110 messages; a rate limit then waits (below).
 */
const BATCH_MIN_MS = 500;
/** On a Gmail rate limit: wait a minute (the quota window), at most 4 tries in all. */
const RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_ATTEMPTS = 4;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Nango allows only flat strings, numbers and booleans; '' means no page token.
const Checkpoint = z.object({
  phase: z.string(),
  historyId: z.string(),
  pageToken: z.string(),
});
const SavedCheckpoint = z.object({
  phase: z.enum(['backfill', 'history']),
  historyId: z.string().min(1),
  pageToken: z.string().transform((token) => token || undefined),
});
type Checkpoint = z.infer<typeof SavedCheckpoint>;

const ProfileSchema = z.object({ historyId: z.string() });

const MessageListSchema = z.object({
  messages: z.array(z.object({ id: z.string() })).optional(),
  nextPageToken: z.string().optional(),
});

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

const sync = createSync({
  description: 'New mail in the Gmail inbox, without spam, trash, Promotions and Social',
  version: '1.0.0',
  frequency: 'every 5 minutes',
  autoStart: true,
  checkpoint: Checkpoint,
  models: { InboxMessage },
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],

  exec: async (nango) => {
    /** nango.get, waiting out Gmail's per-minute quota instead of failing the run. */
    const get = (config: Parameters<typeof nango.get>[0]) =>
      patiently(async () => await nango.get(config), {
        attempts: RATE_LIMIT_ATTEMPTS,
        waitMs: RATE_LIMIT_WAIT_MS,
        wait: pause,
        onWait: async (attempt) => {
          await nango.log(`Gmail rate limit; waiting a minute (attempt ${attempt})`, {
            level: 'warn',
          });
        },
      });

    /** One message as a record, or why not: gone (404) or no longer inbox mail. */
    async function fetchMessage(
      id: string,
      backfill: boolean,
    ): Promise<{ record: InboxMessage } | { removed: true } | { skipped: true }> {
      try {
        const response = await get({
          // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
          endpoint: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
          params: { format: 'full' },
          retries: 3,
        });
        const message = GmailMessage.parse(response.data);
        if (isRemoved(message.labelIds)) return { removed: true };
        if (!isInboxMail(message.labelIds)) return { skipped: true };
        return { record: toInboxMessage(message, backfill) };
      } catch (error) {
        if (statusOf(error) === 404) return { removed: true };
        throw error;
      }
    }

    /** Fetches and saves these messages; returns how many records were saved and removed. */
    async function saveMessages(ids: string[], removeIds: string[], backfill: boolean) {
      const records: InboxMessage[] = [];
      const removed = [...removeIds];
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const started = Date.now();
        const results = await Promise.all(
          ids
            .slice(i, i + CONCURRENCY)
            .map(async (id) => ({ id, result: await fetchMessage(id, backfill) })),
        );
        for (const { id, result } of results) {
          if ('record' in result) records.push(result.record);
          else if ('removed' in result) removed.push(id);
        }
        const elapsed = Date.now() - started;
        if (i + CONCURRENCY < ids.length && elapsed < BATCH_MIN_MS)
          await pause(BATCH_MIN_MS - elapsed);
      }
      if (records.length > 0) await nango.batchSave(records, 'InboxMessage');
      if (removed.length > 0) {
        await nango.batchDelete(
          removed.map((id) => ({ id })),
          'InboxMessage',
        );
      }
    }

    async function backfill(start: Checkpoint) {
      let pageToken = start.pageToken;
      do {
        const response = await get({
          // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
          endpoint: '/gmail/v1/users/me/messages',
          params: {
            q: BACKFILL_QUERY,
            maxResults: String(PAGE_SIZE),
            ...(pageToken ? { pageToken } : {}),
          },
          retries: 3,
        });
        const page = MessageListSchema.parse(response.data);
        await saveMessages(
          (page.messages ?? []).map((message) => message.id),
          [],
          true,
        );
        pageToken = page.nextPageToken;
        await nango.saveCheckpoint(
          pageToken
            ? { phase: 'backfill', historyId: start.historyId, pageToken }
            : { phase: 'history', historyId: start.historyId, pageToken: '' },
        );
      } while (pageToken);
    }

    /** From the profile's current historyId: the start of a (new) backfill. */
    async function startBackfill() {
      const response = await get({
        // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile
        endpoint: '/gmail/v1/users/me/profile',
        retries: 3,
      });
      const { historyId } = ProfileSchema.parse(response.data);
      await nango.saveCheckpoint({ phase: 'backfill', historyId, pageToken: '' });
      await backfill({ phase: 'backfill', historyId, pageToken: undefined });
      return historyId;
    }

    const saved = await nango.getCheckpoint();
    const checkpoint = saved ? SavedCheckpoint.parse(saved) : undefined;
    let historyId: string;
    if (!checkpoint) {
      historyId = await startBackfill();
    } else if (checkpoint.phase === 'backfill') {
      await backfill(checkpoint);
      historyId = checkpoint.historyId;
    } else {
      historyId = checkpoint.historyId;
    }

    let pageToken = checkpoint?.phase === 'history' ? checkpoint.pageToken : undefined;
    do {
      let page: HistoryPage;
      try {
        const response = await get({
          // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
          endpoint: '/gmail/v1/users/me/history',
          params: {
            startHistoryId: historyId,
            maxResults: String(PAGE_SIZE * 5),
            ...(pageToken ? { pageToken } : {}),
          },
          retries: 3,
        });
        page = HistoryListSchema.parse(response.data);
      } catch (error) {
        // historyId too old (Gmail keeps about a week): start over with 14
        // days; the app ignores mail it already has (§4.4).
        if (statusOf(error) !== 404) throw error;
        await nango.log('historyId expired; backfilling again', { level: 'warn' });
        historyId = await startBackfill();
        pageToken = undefined;
        continue;
      }
      const { fetch, remove } = changesOf(page);
      await saveMessages(fetch, remove, false);
      pageToken = page.nextPageToken;
      if (pageToken) {
        await nango.saveCheckpoint({ phase: 'history', historyId, pageToken });
      } else {
        historyId = page.historyId;
        await nango.saveCheckpoint({ phase: 'history', historyId, pageToken: '' });
      }
    } while (pageToken);
  },
});

export default sync;
