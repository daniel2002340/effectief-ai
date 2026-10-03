import { z } from 'zod';

/** Dutch VAT rates in basis points (2100 = 21%). */
export const vatRatesBps = [0, 900, 2100] as const;
export const vatRateBpsSchema = z.literal(vatRatesBps);

/** Amounts are integer cents, never floats (CLAUDE.md). */
export const centsSchema = z.int();
