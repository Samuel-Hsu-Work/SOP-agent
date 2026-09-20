import { z } from "zod";
import { sopSessionSchema } from "./session.ts";

/** The contract for downloading the approved SOP. Like `chatWire.ts`, both sides must agree on it. */
export const sopPdfRequestSchema = z.object({ session: sopSessionSchema });

export type SopPdfRequest = z.infer<typeof sopPdfRequestSchema>;

export const SOP_PDF_MEDIA_TYPE = "application/pdf";

const FILE_NAME_PREFIX = "standard-operating-procedure";

/**
 * The name the download is saved under, from the approval time alone (`YYYY-MM-DDTHH:MM`), so it
 * is ASCII, contains no user text, is the same on every download of one SOP, and tells two SOPs
 * apart. The browser and the API's `content-disposition` compute it with this one function.
 */
export function sopPdfFileName(approvedAt: string): string {
  const stamp = approvedAt.slice(0, 16).replace("T", "-").replaceAll(":", "");
  return `${FILE_NAME_PREFIX}-${stamp}.pdf`;
}
