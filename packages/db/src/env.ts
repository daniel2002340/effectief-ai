import { z } from 'zod';

export const databaseEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
