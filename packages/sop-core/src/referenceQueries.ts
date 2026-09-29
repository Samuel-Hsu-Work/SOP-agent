import type { ReferencePassage } from "./referenceSchema.ts";
import type { SopSession } from "./session.ts";

/*
 * Reading the reference material of a session. Kept apart from `referenceSchema.ts`, which only
 * describes the stored shape, so the schema needs nothing from the session it is part of.
 */

/**
 * A passage is stale once any purpose or scope claim it was judged against is gone or emptied: the
 * SOP's target has changed since, so the passage may no longer apply. A correction keeps the claim's
 * id, and a new scope claim adds to the target, so neither makes a passage stale.
 */
export function isPassageStale(session: SopSession, passage: ReferencePassage): boolean {
  const withValue = new Set(
    session.claims.filter((claim) => claim.value !== null).map((claim) => claim.claimId),
  );
  return passage.targetClaimIds.some((claimId) => !withValue.has(claimId));
}

export function findPassage(session: SopSession, passageId: string): ReferencePassage | undefined {
  return session.references.passages.find((passage) => passage.passageId === passageId);
}
