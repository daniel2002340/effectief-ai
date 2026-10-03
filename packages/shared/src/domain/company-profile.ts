import { z } from 'zod';
import { companySectors } from './status.ts';

// Who the company itself is: context for every prompt, managed by the user
// (docs/data-model.md, company_profile). The e-mail signature is added below
// mails in code, never through the prompt.

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const openingPeriod = z
  .strictObject({ open: time, close: time })
  .refine((period) => period.open < period.close, {
    message: 'Sluitingstijd moet na openingstijd liggen',
    path: ['close'],
  });

const day = z.array(openingPeriod).max(3);

/** Per weekday the opening periods; a missing day is closed. */
export const openingHoursSchema = z.strictObject({
  monday: day.optional(),
  tuesday: day.optional(),
  wednesday: day.optional(),
  thursday: day.optional(),
  friday: day.optional(),
  saturday: day.optional(),
  sunday: day.optional(),
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;

/** Other structured company data; only what a feature needs. */
export const companyDetailsSchema = z.strictObject({
  websiteUrl: z
    .url({ protocol: /^https?$/ })
    .max(200)
    .optional(),
  phone: z.string().trim().min(1).max(50).optional(),
  address: z.string().trim().min(1).max(300).optional(),
});
export type CompanyDetails = z.infer<typeof companyDetailsSchema>;

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullish();

/** Upserting replaces the whole profile; omitted fields become empty. */
export const companyProfileInputSchema = z.strictObject({
  tradeName: z.string().trim().min(1).max(200),
  kvkNumber: z
    .string()
    .regex(/^\d{8}$/)
    .nullish(),
  vatNumber: z
    .string()
    .regex(/^NL\d{9}B\d{2}$/)
    .nullish(),
  sector: z.enum(companySectors),
  servicesDescription: optionalText(2000),
  serviceArea: optionalText(200),
  toneOfVoice: optionalText(200),
  emailSignature: optionalText(2000),
  openingHours: openingHoursSchema.nullish(),
  details: companyDetailsSchema.default({}),
});
export type CompanyProfileInput = z.input<typeof companyProfileInputSchema>;
