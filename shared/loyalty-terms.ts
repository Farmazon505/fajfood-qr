import { z } from "zod";

export const loyaltyTermsSchema = z.object({
  version: z.literal(1),
  welcomeAmount: z.number().positive().max(100_000),
  birthday: z.object({
    amount: z.number().positive(), daysBefore: z.number().int().min(0), daysAfter: z.number().int().min(0),
    description: z.string().min(1).max(3000),
  }).nullable(),
  sections: z.array(z.object({ title: z.string().min(1).max(200), text: z.string().min(1).max(4000) })).min(1).max(20),
});
export type GuestLoyaltyTerms = z.infer<typeof loyaltyTermsSchema>;
