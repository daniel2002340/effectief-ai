import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ActionType,
  actionRegistry,
  actionTypes,
  connectionProviders,
} from '@effectief/shared';
import {
  type ActionAdapter,
  AdapterError,
  type AdapterRegistry,
  type ExecuteRequest,
  type ExecuteResponse,
} from '../adapter.ts';

// A provider for tests: keeps objects in memory and counts effects, so a test
// can prove that nothing happened without approval, that a repeat had exactly
// one effect and that an edit updated the same object. Like a real adapter it
// is idempotent on the key: creating twice with one key returns the first object.

export interface FakeObject {
  id: string;
  provider: string;
  type: ActionType;
  idempotencyKey: string;
  input: unknown;
  /** 1 after creating, +1 per update. */
  version: number;
}

export interface FakeProvider {
  /** One adapter per provider, each able to execute every type it is listed for. */
  adapters: AdapterRegistry;
  /** Every call to execute, also those that failed or were deduplicated. */
  calls: ExecuteRequest[];
  objects: Map<string, FakeObject>;
  /** Effects at the provider: objects created and updated. */
  effects: { created: number; updated: number };
  /** The next `times` calls throw this error (after the delay). */
  failNext(error: AdapterError, times?: number): void;
  /** Delay per call, to widen the window for races. */
  delayMs: number;
}

export function createFakeProvider(): FakeProvider {
  const objects = new Map<string, FakeObject>();
  const byKey = new Map<string, string>();
  const calls: ExecuteRequest[] = [];
  const effects = { created: 0, updated: 0 };
  const failures: AdapterError[] = [];
  let sequence = 0;

  const fake: FakeProvider = {
    adapters: {},
    calls,
    objects,
    effects,
    delayMs: 0,
    failNext(error, times = 1) {
      for (let i = 0; i < times; i++) failures.push(error);
    },
  };

  async function execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    calls.push(request);
    if (fake.delayMs > 0) await sleep(fake.delayMs);
    const failure = failures.shift();
    if (failure) throw failure;

    if (request.providerObjectId) {
      const object = objects.get(request.providerObjectId);
      if (!object) throw new AdapterError('provider_object_missing', { retryable: false });
      object.input = request.input;
      object.version += 1;
      effects.updated += 1;
      return { providerObjectId: object.id, result: {} };
    }

    const existing = byKey.get(request.idempotencyKey);
    if (existing) return { providerObjectId: existing, result: {} };

    sequence += 1;
    const id = `fake-${sequence}`;
    objects.set(id, {
      id,
      provider: request.connection.provider,
      type: request.type,
      idempotencyKey: request.idempotencyKey,
      input: request.input,
      version: 1,
    });
    byKey.set(request.idempotencyKey, id);
    effects.created += 1;
    return { providerObjectId: id, result: {} };
  }

  for (const provider of connectionProviders) {
    const types = actionTypes.filter((type) =>
      (actionRegistry[type].providers as readonly string[]).includes(provider),
    );
    const adapter: ActionAdapter = { provider, actionTypes: types, execute };
    fake.adapters[provider] = adapter;
  }
  return fake;
}
