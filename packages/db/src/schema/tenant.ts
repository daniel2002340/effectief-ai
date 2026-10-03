import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  integer,
  pgPolicy,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './auth.ts';
import { appRuntime, currentTenantId } from './roles.ts';

/**
 * The RLS pattern for every tenant table: the app role sees and writes only
 * rows of the tenant set by withTenant(). FORCE ROW LEVEL SECURITY and the
 * grants are in the migration (drizzle-kit does not generate them).
 */
export const tenantIsolation = (tenantId: AnyPgColumn) =>
  pgPolicy('tenant_isolation', {
    for: 'all',
    to: appRuntime,
    using: sql`${tenantId} = ${currentTenantId}`,
    withCheck: sql`${tenantId} = ${currentTenantId}`,
  });

/** One row per tenant, created together with the organization. */
export const tenantSettings = pgTable(
  'tenant_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** Default VAT rate for new quotes, in basis points (2100 = 21%). */
    defaultVatRateBps: integer('default_vat_rate_bps').default(2100).notNull(),
    /** How long event_contents (mail text) is kept, from occurred_at (#037). */
    contentRetentionDays: integer('content_retention_days').default(90).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check('tenant_settings_vat_rate', sql`${table.defaultVatRateBps} in (0, 900, 2100)`),
    check(
      'tenant_settings_content_retention_days',
      sql`${table.contentRetentionDays} between 30 and 365`,
    ),
    tenantIsolation(table.tenantId),
  ],
).enableRLS();
