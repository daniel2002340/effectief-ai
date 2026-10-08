import { createSync } from 'nango';
import * as z from 'zod';
import {
  ATTACHMENT_SELECT,
  AttachmentList,
  attachmentsOf,
  DeltaPage,
  deltaEntryOf,
  type GraphMessage,
  InboxMessage,
  MESSAGE_SELECT,
  requestOfLink,
  toInboxMessage,
} from '../helpers/message.js';

// New mail in the Outlook inbox (docs/integrations.md §3.1–§3.2, decision #074).
//
// Change source: a Graph delta query on the inbox, like Nango's template. The
// first round asks for the last 14 days (backfill); its deltaLink starts the
// next round. Checkpoint: { link, backfill }, where link is the nextLink to
// resume a round or the deltaLink to start the next ('' = start over).
// Deletes: Graph reports `@removed` (reason "deleted") both when a message is
// deleted and when it merely leaves the inbox (archived, moved). So each one
// is looked up by its immutable id: gone, or in Deleted Items or Junk →
// batchDelete; elsewhere → nothing, the mail still exists. An expired delta token (410) starts over
// with 14 days; the app ignores mail it already has (§4.4).

const BACKFILL_DAYS = 14;
const PAGE_SIZE = 50;
/** Parallel attachment lookups; Graph allows 4 concurrent requests per mailbox. */
const CONCURRENCY = 4;

// Nango allows only flat strings, numbers and booleans.
const Checkpoint = z.object({ link: z.string(), backfill: z.boolean() });

const FolderSchema = z.object({ id: z.string() });
const LocationSchema = z.object({ parentFolderId: z.string().nullish() });

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

const sync = createSync({
  description: 'New mail in the Outlook inbox, without junk and deleted items',
  version: '1.0.0',
  frequency: 'every 5 minutes',
  autoStart: true,
  checkpoint: Checkpoint,
  models: { InboxMessage },
  scopes: ['offline_access', 'User.Read', 'Mail.Read'],

  exec: async (nango) => {
    // Immutable ids on every call: a default Graph id changes when a message
    // moves to another folder, so an archived message would look deleted
    // (seen in a dry run, 2026-10-08). Immutable ids stay while the message
    // stays in the mailbox (https://learn.microsoft.com/graph/outlook-immutable-id).
    const immutable = { Prefer: 'IdType="ImmutableId"' };
    const headers = {
      // Text instead of HTML, so the HTML body never reaches the function.
      Prefer: `IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=${PAGE_SIZE}`,
    };

    /** The ids of Deleted Items and Junk: a message moved there is gone for us. */
    async function goneFolderIds(): Promise<Set<string>> {
      const ids = new Set<string>();
      for (const name of ['deleteditems', 'junkemail']) {
        const response = await nango.get({
          // https://learn.microsoft.com/graph/api/mailfolder-get
          endpoint: `/v1.0/me/mailFolders/${name}`,
          params: { $select: 'id' },
          headers: immutable,
          retries: 3,
        });
        ids.add(FolderSchema.parse(response.data).id);
      }
      return ids;
    }

    /** Whether a message that left the inbox is gone for us (§4.5), or merely moved. */
    async function isGone(id: string, gone: Set<string>): Promise<boolean> {
      try {
        const response = await nango.get({
          // https://learn.microsoft.com/graph/api/message-get
          endpoint: `/v1.0/me/messages/${encodeURIComponent(id)}`,
          params: { $select: 'parentFolderId' },
          headers: immutable,
          retries: 3,
        });
        const { parentFolderId } = LocationSchema.parse(response.data);
        return !parentFolderId || gone.has(parentFolderId);
      } catch (error) {
        if (statusOf(error) === 404) return true;
        throw error;
      }
    }

    async function attachmentsFor(message: GraphMessage) {
      if (!message.hasAttachments) return [];
      const response = await nango.get({
        // https://learn.microsoft.com/graph/api/message-list-attachments
        endpoint: `/v1.0/me/messages/${encodeURIComponent(message.id)}/attachments`,
        params: { $select: ATTACHMENT_SELECT },
        headers: immutable,
        retries: 3,
      });
      return attachmentsOf(AttachmentList.parse(response.data).value);
    }

    /** Takes one delta page in: records, deletes and what merely left the inbox. */
    async function takeIn(page: DeltaPage, backfill: boolean, gone: () => Promise<Set<string>>) {
      const messages: GraphMessage[] = [];
      const removedIds: string[] = [];
      for (const raw of page.value) {
        const entry = deltaEntryOf(raw);
        if (entry.kind === 'removed') removedIds.push(entry.id);
        else if (entry.kind === 'message' && !entry.message.isDraft) messages.push(entry.message);
      }

      const records: InboxMessage[] = [];
      for (let i = 0; i < messages.length; i += CONCURRENCY) {
        const batch = messages.slice(i, i + CONCURRENCY);
        const attachments = await Promise.all(batch.map(attachmentsFor));
        batch.forEach((message, index) => {
          records.push(toInboxMessage(message, attachments[index] ?? [], backfill));
        });
      }

      const deleted: { id: string }[] = [];
      if (removedIds.length > 0) {
        const folders = await gone();
        for (const id of removedIds) {
          if (await isGone(id, folders)) deleted.push({ id });
        }
      }

      if (records.length > 0) await nango.batchSave(records, 'InboxMessage');
      if (deleted.length > 0) await nango.batchDelete(deleted, 'InboxMessage');
    }

    let folders: Set<string> | undefined;
    const gone = async () => {
      folders ??= await goneFolderIds();
      return folders;
    };

    const saved = await nango.getCheckpoint();
    const checkpoint = saved ? Checkpoint.parse(saved) : undefined;
    let link = checkpoint?.link || undefined;
    let backfill = checkpoint ? checkpoint.backfill : true;

    for (;;) {
      let page: DeltaPage;
      try {
        const request = link
          ? requestOfLink(link)
          : {
              // https://learn.microsoft.com/graph/api/message-delta
              endpoint: '/v1.0/me/mailFolders/inbox/messages/delta',
              params: {
                $select: MESSAGE_SELECT,
                $filter: `receivedDateTime ge ${new Date(
                  Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000,
                ).toISOString()}`,
              },
            };
        const response = await nango.get({ ...request, headers, retries: 3 });
        page = DeltaPage.parse(response.data);
      } catch (error) {
        // The delta token expired: start over with 14 days.
        if (statusOf(error) !== 410 || !link) throw error;
        await nango.log('Delta token expired; backfilling again', { level: 'warn' });
        link = undefined;
        backfill = true;
        await nango.saveCheckpoint({ link: '', backfill: true });
        continue;
      }

      await takeIn(page, backfill, gone);

      const next = page['@odata.nextLink'];
      if (next) {
        link = next;
        await nango.saveCheckpoint({ link, backfill });
        continue;
      }
      const delta = page['@odata.deltaLink'];
      if (!delta) throw new Error('Graph delta page without nextLink or deltaLink');
      await nango.saveCheckpoint({ link: delta, backfill: false });
      return;
    }
  },
});

export default sync;
