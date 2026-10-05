import { z } from 'zod';
import { NANGO_API_URL } from './constants.ts';

// Our own small Nango client (decision #079, docs/integrations.md §7.2):
// `fetch` plus Zod on every answer, only the calls we make. Server-side only;
// the key never leaves the api or worker. Errors carry the status and Nango's
// error code, never a response body (it can hold provider text).

export type NangoErrorKind =
  /** 404: the connection (or integration) does not exist. */
  | 'not_found'
  /** 401/403: wrong key or a scope the key lacks. */
  | 'unauthorized'
  /** 400/409/422: Nango refused the request. */
  | 'rejected'
  /** 429 */
  | 'rate_limited'
  /** 5xx, timeouts, network errors, or an answer that does not match its schema. */
  | 'unavailable';

export class NangoApiError extends Error {
  override readonly name = 'NangoApiError';
  readonly kind: NangoErrorKind;
  readonly status: number | undefined;
  /** Nango's `error.code`, when the answer had one. */
  readonly code: string | undefined;

  constructor(kind: NangoErrorKind, operation: string, status?: number, code?: string) {
    super(
      `Nango ${operation} failed: ${kind}${status ? ` (${status})` : ''}${code ? ` ${code}` : ''}`,
    );
    this.kind = kind;
    this.status = status;
    this.code = code;
  }

  /** Worth retrying later (job retries); the others will fail again. */
  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'rate_limited';
  }
}

const connectSessionSchema = z.object({
  data: z.object({ token: z.string().min(1), expires_at: z.iso.datetime({ offset: true }) }),
});
export interface ConnectSession {
  token: string;
  expiresAt: Date;
}

const connectionTagsSchema = z.record(z.string(), z.string());

const listedConnectionSchema = z.object({
  connection_id: z.string(),
  provider_config_key: z.string(),
  provider: z.string(),
  tags: connectionTagsSchema.nullish(),
});
const connectionListSchema = z.object({ connections: z.array(listedConnectionSchema) });

/** A connection without credentials: we never ask for or keep tokens. */
export interface NangoConnection {
  connectionId: string;
  integrationId: string;
  provider: string;
  tags: Record<string, string>;
}

const connectionSchema = listedConnectionSchema.extend({
  errors: z.array(z.object({ type: z.string() })).default([]),
});
export interface NangoConnectionHealth extends NangoConnection {
  /** Nango has an auth error on this connection: the grant no longer works. */
  authError: boolean;
}

const errorBodySchema = z.object({ error: z.object({ code: z.string() }) });

export interface NangoClientOptions {
  secretKey: string;
  /** Tests pass a fake; defaults to the global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Per request; Nango's actions can take a while. */
  timeoutMs?: number;
}

export interface CreateConnectSessionInput {
  integrationId: string;
  tags: Record<string, string>;
  /** Only for local development (§7.4); undefined means the environment's URLs. */
  webhookUrlOverride?: string | undefined;
}

export interface CreateReconnectSessionInput {
  integrationId: string;
  connectionId: string;
  webhookUrlOverride?: string | undefined;
}

export interface ConnectionRef {
  integrationId: string;
  connectionId: string;
}

export function createNangoClient({
  secretKey,
  fetch: fetchImpl = fetch,
  baseUrl = NANGO_API_URL,
  timeoutMs = 20_000,
}: NangoClientOptions) {
  async function call<T>(
    operation: string,
    path: string,
    schema: z.ZodType<T>,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${secretKey}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new NangoApiError('unavailable', operation);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = errorBodySchema.safeParse(body).data?.error.code;
      throw new NangoApiError(kindOf(response.status), operation, response.status, code);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new NangoApiError('unavailable', operation, response.status);
    return parsed.data;
  }

  const toSession = ({ data }: z.infer<typeof connectSessionSchema>): ConnectSession => ({
    token: data.token,
    expiresAt: new Date(data.expires_at),
  });

  const toConnection = (row: z.infer<typeof listedConnectionSchema>): NangoConnection => ({
    connectionId: row.connection_id,
    integrationId: row.provider_config_key,
    provider: row.provider,
    tags: row.tags ?? {},
  });

  const connectionPath = ({ connectionId, integrationId }: ConnectionRef) =>
    `/connections/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(integrationId)}`;

  return {
    /** A 30-minute session for one new connection, carrying our tags (§2.1). */
    async createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSession> {
      return toSession(
        await call('create connect session', '/connect/sessions', connectSessionSchema, {
          method: 'POST',
          body: {
            tags: input.tags,
            allowed_integrations: [input.integrationId],
            ...(input.webhookUrlOverride ? { webhook_url_override: input.webhookUrlOverride } : {}),
          },
        }),
      );
    },

    /** A session that re-authorizes an existing connection (§2.4). */
    async createReconnectSession(input: CreateReconnectSessionInput): Promise<ConnectSession> {
      return toSession(
        await call(
          'create reconnect session',
          '/connect/sessions/reconnect',
          connectSessionSchema,
          {
            method: 'POST',
            body: {
              connection_id: input.connectionId,
              integration_id: input.integrationId,
              ...(input.webhookUrlOverride
                ? { webhook_url_override: input.webhookUrlOverride }
                : {}),
            },
          },
        ),
      );
    },

    /** Connections whose tags all match; the safety net looks up attempts this way (§2.3). */
    async listConnectionsByTags(tags: Record<string, string>): Promise<NangoConnection[]> {
      const query = new URLSearchParams(
        Object.entries(tags).map(([key, value]): [string, string] => [`tags[${key}]`, value]),
      );
      const { connections } = await call(
        'list connections',
        `/connections?${query}`,
        connectionListSchema,
      );
      return connections.map(toConnection);
    },

    /** One connection, without credentials; the health check reads its errors (§4.6). */
    async getConnection(ref: ConnectionRef): Promise<NangoConnectionHealth> {
      const row = await call('get connection', connectionPath(ref), connectionSchema);
      return { ...toConnection(row), authError: row.errors.some((error) => error.type === 'auth') };
    },

    /** Deletes a connection; one that is already gone counts as deleted. */
    async deleteConnection(ref: ConnectionRef): Promise<{ deleted: boolean }> {
      try {
        await call('delete connection', connectionPath(ref), z.unknown(), { method: 'DELETE' });
        return { deleted: true };
      } catch (error) {
        if (error instanceof NangoApiError && error.kind === 'not_found') return { deleted: false };
        throw error;
      }
    },

    /** Runs one of our Nango actions and parses its output with the given schema. */
    async triggerAction<T>(
      ref: ConnectionRef,
      actionName: string,
      output: z.ZodType<T>,
      input: Record<string, unknown> = {},
    ): Promise<T> {
      return call(`action ${actionName}`, '/action/trigger', output, {
        method: 'POST',
        headers: { 'connection-id': ref.connectionId, 'provider-config-key': ref.integrationId },
        body: { action_name: actionName, input },
      });
    },
  };
}

export type NangoClient = ReturnType<typeof createNangoClient>;

function kindOf(status: number): NangoErrorKind {
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500 || status === 424) return 'unavailable';
  return 'rejected';
}
