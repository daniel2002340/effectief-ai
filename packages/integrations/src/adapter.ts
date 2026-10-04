import type {
  ActionErrorCode,
  ActionInput,
  ActionResult,
  ActionType,
  ConnectionProvider,
} from '@effectief/shared';

// The shared interface every provider adapter implements (CLAUDE.md,
// integrations). Only the execute job of the action pipeline calls it, after
// approval; routes, other jobs and AI tools never do (#004).

/** The connection to execute through; tokens stay at Nango. */
export interface AdapterConnection {
  tenantId: string;
  connectionId: string;
  provider: ConnectionProvider;
  nangoIntegrationId: string;
  nangoConnectionId: string;
}

export type ExecuteRequest = {
  [T in ActionType]: {
    type: T;
    input: ActionInput<T>;
    connection: AdapterConnection;
    /**
     * Deterministic per action (`<card_id>:<type>:<ordinal>`). Creating twice
     * with the same key must return the first object, not make a second: a
     * job can crash after the provider created the object but before we
     * stored its ID, and the retry then calls again.
     */
    idempotencyKey: string;
    /** Set when the action was executed before: update this object, never create one. */
    providerObjectId: string | null;
  };
}[ActionType];

export interface ExecuteResponse {
  /** On an update, the same ID as the request (the database refuses another). */
  providerObjectId: string;
  /** Validated against the result schema of the type before it is stored. */
  result: ActionResult;
}

export interface ActionAdapter {
  readonly provider: ConnectionProvider;
  readonly actionTypes: readonly ActionType[];
  execute(request: ExecuteRequest): Promise<ExecuteResponse>;
}

/**
 * A failed provider call. `retryable` errors are retried by the job; the
 * others fail the action at once. The message is for logs only and must not
 * contain provider response bodies (they can hold personal data).
 */
export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly code: ActionErrorCode;
  readonly retryable: boolean;

  constructor(code: ActionErrorCode, { retryable }: { retryable: boolean }) {
    super(`adapter error: ${code}${retryable ? ' (retryable)' : ''}`);
    this.code = code;
    this.retryable = retryable;
  }
}

export type AdapterRegistry = Partial<Record<ConnectionProvider, ActionAdapter>>;

/** The adapter that can execute `type` through `provider`, if there is one. */
export function adapterFor(
  registry: AdapterRegistry,
  provider: ConnectionProvider,
  type: ActionType,
): ActionAdapter | undefined {
  const adapter = registry[provider];
  return adapter?.actionTypes.includes(type) ? adapter : undefined;
}
