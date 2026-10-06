// Nango webhook bodies for tests.
//
// auth/creation and auth/deletion: captured from the Nango logs of the
// staging environment (2026-10-06, logs_get_operation), anonymized: every ID,
// the nonce and the tags replaced by test values, same structure and fields.
// They settle what the docs left open: `environment` is the environment name
// in lower case ("staging"), `tags` is present on both, and every auth body
// carries `from: "nango"`.
//
// sync (finished): captured on staging the same way, with the connection ID
// and Gmail's historyId replaced. It carries more than the docs show:
// `from`, `queryTimeStamp`, `syncVariant`, and our flat checkpoint (#085).
//
// The others (override, refresh, a failed sync) follow the examples in the
// Nango docs (guides/platform/webhooks-from-nango, read 2026-10-05) with the
// same base: staging had not sent them by 2026-10-06. Replace them once it
// has (docs/todo.md).

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
  /** Captured on staging. */
  syncSuccess: {
    syncName: 'inbox-messages',
    checkpoints: {
      from: { phase: 'history', historyId: '1000100', pageToken: '' },
      to: { phase: 'history', historyId: '1000120', pageToken: '' },
    },
    queryTimeStamp: '2026-10-06T16:22:07.703Z',
    type: 'sync',
    syncVariant: 'base',
    responseResults: { deleted: 0, added: 2, updated: 0 },
    modifiedAfter: '2026-10-06T16:22:07.703Z',
    success: true,
    connectionId,
    from: 'nango',
    model: 'InboxMessage',
    syncType: 'INCREMENTAL',
    providerConfigKey: 'gmail',
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
