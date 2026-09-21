import { SOP_FIELD_NAMES } from "@sop-agent/sop-core";
import { z } from "zod";

/**
 * What the extraction model may say. There is no status, authority, creator, source type or tool
 * call in it: the model reports what a document states, and code decides everything else. The
 * schema also cannot express "confirm this", so a document that asks for it has nothing to ask.
 */
export const extractionOutputSchema = z.object({
  claims: z.array(
    z.object({
      field: z.enum(SOP_FIELD_NAMES),
      /** One plain English sentence saying the rule. */
      summary: z.string(),
      /** Copied character for character from one section. */
      quote: z.string(),
      /** The id of the section that holds the quote, from the input. */
      sectionId: z.string(),
      /** YYYY-MM-DD when the document says when the rule takes effect, otherwise null. */
      effectiveDate: z.string().nullable(),
    }),
  ),
});

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

export const EXTRACTION_SCHEMA_NAME = "sop_claim_extraction";
