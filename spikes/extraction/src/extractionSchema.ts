import { z } from "zod";

export const SOP_FIELD_NAMES = [
  "purpose",
  "scope",
  "trigger",
  "roles",
  "procedure",
  "authorization",
  "completionCriteria",
  "governance",
  "exceptions",
  "evidence",
  "controls",
  "decisionRules",
  "prerequisites",
] as const;

export const extractedClaimSchema = z.object({
  field: z.enum(SOP_FIELD_NAMES),
  summary: z.string(),
  quote: z.string(),
  location: z.string(),
});

export const extractionResultSchema = z.object({
  claims: z.array(extractedClaimSchema),
});

export type ExtractedClaim = z.infer<typeof extractedClaimSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
