// Nango webhook bodies for tests.
//
// NOT CAPTURED FROM REAL WEBHOOKS. These follow the examples in the Nango docs
// (guides/platform/webhooks-from-nango, read 2026-10-05): the staging
// environment had sent no webhook yet, so its logs held nothing to capture.
// Replace them with anonymized real bodies after the first connection on
// staging (docs/todo.md). Unknown from the docs: the exact form of
// `environment` (the docs show "DEV | PROD") and whether `tags` is present on
// every auth operation.

const connectionId = '3f2b9c4e-1d7a-4e6b-9a51-0c8d2e7f6a13';
const tenantId = '0199a1b2-0000-7000-8000-00000000a001';
const userId = '0199a1b2-0000-7000-8000-00000000b001';
const nonce = 'a'.repeat(64);

const authBase = {
  type: 'auth',
  connectionId,
  authMode: 'OAUTH2',
  providerConfigKey: 'gmail',
  provider: 'google-mail',
  environment: 'staging',
  tags: {
    organization_id: tenantId,
    end_user_id: userId,
    connect_attempt: nonce,
  },
} as const;

export const nangoWebhookFixtures = {
  ids: { connectionId, tenantId, userId, nonce },
  authCreation: { ...authBase, operation: 'creation', success: true },
  authOverride: { ...authBase, operation: 'override', success: true },
  authRefreshFailed: {
    ...authBase,
    operation: 'refresh',
    success: false,
    error: { type: 'refresh_token_external_error', description: 'Provider text with a name' },
  },
  authRefreshRecovered: { ...authBase, operation: 'refresh', success: true },
  authDeletion: { ...authBase, operation: 'deletion', success: true },
  syncSuccess: {
    type: 'sync',
    connectionId,
    providerConfigKey: 'gmail',
    syncName: 'inbox-messages',
    model: 'InboxMessage',
    syncType: 'INCREMENTAL',
    success: true,
    modifiedAfter: '2026-10-05T12:00:00.000Z',
    responseResults: { added: 2, updated: 0, deleted: 0 },
    checkpoints: { from: { historyId: '100' }, to: { historyId: '120' } },
  },
  syncFailed: {
    type: 'sync',
    connectionId,
    providerConfigKey: 'gmail',
    syncName: 'inbox-messages',
    model: 'InboxMessage',
    syncType: 'INCREMENTAL',
    success: false,
    error: { type: 'script_error', description: 'Provider text' },
    startedAt: '2026-10-05T12:00:00.000Z',
    failedAt: '2026-10-05T12:00:05.000Z',
    checkpoints: null,
  },
  /** A type we do not handle: acknowledged and ignored. */
  forward: {
    type: 'forward',
    from: 'google-mail',
    connectionId,
    providerConfigKey: 'gmail',
    payload: { anything: true },
  },
} as const;
