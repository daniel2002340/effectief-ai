import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { INBOX_MESSAGE_MODEL, inboxMessageSchema } from './inbox-message.ts';

// The record model exists twice (docs/integrations.md §7.5): in the Nango
// function and here. `nango compile` writes the function's model as JSON
// schema into .nango/nango.json (committed; CI fails when it is stale).

const nangoJson = new URL(
  '../../../integrations/nango-integrations/.nango/nango.json',
  import.meta.url,
);

const syncSchema = z.object({
  name: z.string(),
  json_schema: z.object({ definitions: z.record(z.string(), z.unknown()) }),
});
const nangoDefinitions = z.array(
  z.object({ providerConfigKey: z.string(), syncs: z.array(syncSchema) }),
);

/** Descriptions are documentation, not structure. */
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'description' && key !== '$schema')
        .map(([key, nested]) => [key, withoutDescriptions(nested)]),
    );
  }
  return value;
}

describe('inboxMessageSchema', () => {
  it.each(['gmail'])('matches the %s inbox-messages model in the Nango function', (provider) => {
    const integrations = nangoDefinitions.parse(JSON.parse(readFileSync(nangoJson, 'utf8')));
    const sync = integrations
      .find((integration) => integration.providerConfigKey === provider)
      ?.syncs.find((candidate) => candidate.name === 'inbox-messages');
    expect(sync).toBeDefined();
    const fromNango = sync?.json_schema.definitions[INBOX_MESSAGE_MODEL];
    expect(withoutDescriptions(fromNango)).toEqual(
      withoutDescriptions(z.toJSONSchema(inboxMessageSchema, { target: 'draft-7' })),
    );
  });

  it('refuses fields beyond the model, such as HTML', () => {
    const record = {
      id: 'm1',
      threadId: 't1',
      receivedAt: '2026-10-06T08:00:00.000Z',
      to: [],
      cc: [],
      bodyText: '',
      labels: ['INBOX'],
      attachments: [],
      backfill: false,
    };
    expect(inboxMessageSchema.safeParse(record).success).toBe(true);
    expect(inboxMessageSchema.safeParse({ ...record, html: '<p>x</p>' }).success).toBe(false);
    expect(
      inboxMessageSchema.safeParse({
        ...record,
        attachments: [
          { name: 'a.pdf', mimeType: 'application/pdf', size: 1, attachmentId: 'x', data: 'QUJD' },
        ],
      }).success,
    ).toBe(false);
  });
});
