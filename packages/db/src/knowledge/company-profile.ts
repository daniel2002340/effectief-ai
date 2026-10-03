import { type CompanyProfileInput, companyProfileInputSchema } from '@effectief/shared';
import { single } from '../memory/source.ts';
import { companyProfile } from '../schema/index.ts';
import type { TenantTransaction } from '../with-tenant.ts';

// One row per tenant, managed by the user (docs/data-model.md, company_profile).
// The tenant comes from the transaction (column default), like every table.

export type CompanyProfile = typeof companyProfile.$inferSelect;

export async function getCompanyProfile(tx: TenantTransaction) {
  const [row] = await tx.select().from(companyProfile);
  return row;
}

/** Creates or replaces the profile; omitted optional fields become empty. */
export async function upsertCompanyProfile(tx: TenantTransaction, input: CompanyProfileInput) {
  const parsed = companyProfileInputSchema.parse(input);
  const values = {
    ...parsed,
    kvkNumber: parsed.kvkNumber ?? null,
    vatNumber: parsed.vatNumber ?? null,
    servicesDescription: parsed.servicesDescription ?? null,
    serviceArea: parsed.serviceArea ?? null,
    toneOfVoice: parsed.toneOfVoice ?? null,
    emailSignature: parsed.emailSignature ?? null,
    openingHours: parsed.openingHours ?? null,
  };
  return single(
    await tx
      .insert(companyProfile)
      .values(values)
      .onConflictDoUpdate({ target: companyProfile.tenantId, set: values })
      .returning(),
  );
}
