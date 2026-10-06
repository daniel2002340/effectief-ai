// Nango webhook bodies for tests.
//
// auth/creation and auth/deletion: captured from the Nango logs of the
// staging environment (2026-10-06, logs_get_operation), anonymized: every ID,
// the nonce and the tags replaced by test values, same structure and fields.
// They settle what the docs left open: `environment` is the environment name
// in lower case ("staging"), `tags` is present on both, and every auth body
// carries `from: "nango"`.
//
// The others (override, refresh, sync) follow the examples in the Nango docs
// (guides/platform/webhooks-from-nango, read 2026-10-05) with the same base:
// staging has not sent them yet. Replace them once it has (docs/todo.md).

const connectionId = '3f2b9c4e-1d7a-4e6b-9a51-0c8d2e7f6a13';
const tenantId = '0199a1b2-0000-7000-8000-00000000a001';
const userId = '0199a1b2-0000-7000-8000-00000000b001';
const nonce = 'a'.repeat(64);

const authBase = {
  authMode: 'OAUTH2',
  environment: 'staging',
  provider: 'google-mail',
  connectionId,
  from: 'nango',
  type: 'auth',
  providerConfigKey: 'gmail',
  tags: {
    organization_id: tenantId,
    end_user_id: userId,
    connect_attempt: nonce,
  },
} as const;

export const nangoWebhookFixtures = {
  ids: { connectionId, tenantId, userId, nonce },
  /** Captured on staging. */
  authCreation: { ...authBase, success: true, operation: 'creation' },
  authOverride: { ...authBase, operation: 'override', success: true },
  authRefreshFailed: {
    ...authBase,
    operation: 'refresh',
    success: false,
    error: { type: 'refresh_token_external_error', description: 'Provider text with a name' },
  },
  authRefreshRecovered: { ...authBase, operation: 'refresh', success: true },
  /** Captured on staging. */
  authDeletion: { ...authBase, success: true, operation: 'deletion' },
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
