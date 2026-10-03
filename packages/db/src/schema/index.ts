// Drizzle schema. Every table with customer data gets `tenant_id` and an RLS
// policy, plus a test proving tenant A cannot read or change tenant B's rows.
export {};
