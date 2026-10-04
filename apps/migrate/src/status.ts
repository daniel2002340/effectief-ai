// Start command of the `migrate` service. The work happened in the pre-deploy
// command (main.ts); this only records the result and exits, so no process
// keeps the owner's credentials once migrations are done (decision #058).
import { expectedMigration } from '@effectief/db/deploy';
import { pino } from 'pino';

pino().info({ migration: expectedMigration.tag }, 'schema is up to date');
