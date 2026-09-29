import { SOP_FIELD_NAMES } from "@sop-agent/sop-core";
import { z } from "zod";

/**
 * What the document reader may say. There is no status, authority, creator, source type, state or
 * tool call in it: the model reports what a document says for this SOP, and code decides everything
 * else. The schema also cannot express "confirm this", so a document that asks for it has nothing
 * to ask. Lengths and counts are enforced by code, not stated here: provider structured output does
 * not reliably support them.
 */
export const extractionOutputSchema = z.object({
  passages: z.array(
    z.object({
      field: z.enum(SOP_FIELD_NAMES),
      /** One short sentence saying the rule as it applies to this SOP. */
      statement: z.string(),
      /** Copied character for character from one section. */
      quote: z.string(),
      /** The id of the section that holds the quote, from the input. */
      sectionId: z.string(),
      /** YYYY-MM-DD when the document says when the rule takes effect, otherwise null. */
      effectiveDate: z.string().nullable(),
    }),
  ),
});

export const EXTRACTION_SCHEMA_NAME = "sop_reference_passages";
