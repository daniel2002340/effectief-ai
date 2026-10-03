import { parseEnv } from '@effectief/shared';
import { webEnvSchema } from '../env.ts';

export const env = parseEnv(webEnvSchema, import.meta.env);
