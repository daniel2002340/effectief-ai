import { describe, expect, it } from 'vitest';
import { AdapterError, adapterFor, type ExecuteRequest } from './adapter.ts';
import { createFakeProvider } from './testing/fake-provider.ts';

const connection = {
  tenantId: '00000000-0000-4000-8000-00000000000a',
  connectionId: '00000000-0000-4000-8000-00000000000b',
  provider: 'moneybird',
  nangoIntegrationId: 'moneybird',
  nangoConnectionId: 'conn-1',
} as const;

const quote = (providerObjectId: string | null, reference?: string): ExecuteRequest => ({
  type: 'moneybird.quote',
  input: {
    providerContactId: 'contact-1',
    reference,
    lines: [{ description: 'Werk', quantity: '1', unitPriceExclVatCents: 1000, vatRateBps: 2100 }],
  },
  connection,
  idempotencyKey: 'card-1:moneybird.quote:1',
  providerObjectId,
});

describe('adapterFor', () => {
  it('only returns an adapter that can execute the type', () => {
    const { adapters } = createFakeProvider();
    expect(adapterFor(adapters, 'moneybird', 'moneybird.quote')).toBeDefined();
    expect(adapterFor(adapters, 'moneybird', 'email.reply')).toBeUndefined();
    expect(adapterFor({}, 'gmail', 'email.reply')).toBeUndefined();
  });
});

describe('fake provider', () => {
  it('is idempotent on the key and updates the same object', async () => {
    const fake = createFakeProvider();
    const adapter = adapterFor(fake.adapters, 'moneybird', 'moneybird.quote');
    const first = await adapter?.execute(quote(null));
    const again = await adapter?.execute(quote(null));
    expect(again?.providerObjectId).toBe(first?.providerObjectId);
    await adapter?.execute(quote(first?.providerObjectId ?? null, 'Aangepast'));
    expect(fake.effects).toEqual({ created: 1, updated: 1 });
    expect(fake.objects.get(first?.providerObjectId ?? '')?.version).toBe(2);
  });

  it('throws queued failures, and a missing object on update', async () => {
    const fake = createFakeProvider();
    const adapter = adapterFor(fake.adapters, 'moneybird', 'moneybird.quote');
    fake.failNext(new AdapterError('provider_unavailable', { retryable: true }));
    await expect(adapter?.execute(quote(null))).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    await expect(adapter?.execute(quote('fake-404'))).rejects.toMatchObject({
      code: 'provider_object_missing',
      retryable: false,
    });
    expect(fake.effects).toEqual({ created: 0, updated: 0 });
  });
});
