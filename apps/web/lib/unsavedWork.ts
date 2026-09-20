import type { SopSession } from "@sop-agent/sop-core";

/**
 * Would closing or reloading the tab lose work that cannot be recovered? The session lives only in
 * this tab, so it is lost with it; the downloaded PDF is the only durable record.
 *
 * - An approved SOP is at risk until its PDF has been downloaded.
 * - A draft is at risk once anything is in it. A first turn still in flight counts, because
 *   nothing is committed to the session until the turn finishes.
 */
export function wouldLoseWork(session: SopSession, isTurnInFlight: boolean): boolean {
  if (session.status === "approved") return session.downloadedAt === null;
  return isTurnInFlight || session.messages.length > 0 || session.claims.length > 0;
}
