import { describe, expect, it } from "vitest";
import type { Claim } from "./claim.ts";
import { computeGaps } from "./computeGaps.ts";
import { createEmptySession, type SopSession } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import { buildClaim, createDeterministicContext } from "./testing.ts";

function sessionWithClaims(...claims: Claim[]): SopSession {
  return { ...createEmptySession(createDeterministicContext()), claims };
}

function readinessOf(session: SopSession, field: SopFieldName) {
  const readiness = computeGaps(session).fields.find((entry) => entry.field === field);
  if (readiness === undefined) throw new Error(`No readiness for ${field}`);
  return readiness;
}

describe("computeGaps", () => {
  it("reports 13 gaps for an empty session: eight blocking and five advisory", () => {
    const report = computeGaps(createEmptySession(createDeterministicContext()));
    expect(report.fields).toHaveLength(13);
    expect(report.gaps).toHaveLength(13);
    expect(report.blockingGapCount).toBe(8);
    expect(report.advisoryGapCount).toBe(5);
    expect(report.gaps.every((entry) => entry.gap?.reason === "empty")).toBe(true);
  });

  it("lists fields in the canonical order with blocking fields first", () => {
    const report = computeGaps(createEmptySession(createDeterministicContext()));
    const classes = report.fields.map((entry) => entry.fieldClass);
    expect(classes).toEqual([...Array(8).fill("blocking"), ...Array(5).fill("advisory")]);
    expect(report.fields[0]?.field).toBe("purpose");
    expect(report.fields[12]?.field).toBe("prerequisites");
  });

  it("treats a field with an observed claim as resolved", () => {
    const readiness = readinessOf(
      sessionWithClaims(buildClaim({ claimId: "c1", field: "purpose", status: "observed" })),
      "purpose",
    );
    expect(readiness.state).toBe("resolved");
    expect(readiness.gap).toBeNull();
  });

  it("treats a proposed claim as resolved too: observed and proposed never create a gap", () => {
    const readiness = readinessOf(
      sessionWithClaims(
        buildClaim({
          claimId: "c1",
          field: "scope",
          status: "proposed",
          authority: "proposed",
          source: {
            type: "agent_suggestion",
            reference: { kind: "message", messageId: "message-1" },
          },
        }),
      ),
      "scope",
    );
    expect(readiness.state).toBe("resolved");
    expect(readiness.gap).toBeNull();
  });

  it.each(["unknown", "conflict", "extracted"] as const)(
    "creates a gap for a %s claim",
    (status) => {
      const readiness = readinessOf(
        sessionWithClaims(buildClaim({ claimId: "c1", field: "roles", status })),
        "roles",
      );
      expect(readiness.state).toBe("unresolved");
      expect(readiness.gap).toEqual({ severity: "blocking", reason: "unresolved" });
      expect(readiness.unresolvedClaimIds).toEqual(["c1"]);
    },
  );

  it("takes severity from the field's class, not from the claim's status", () => {
    const session = sessionWithClaims(
      buildClaim({ claimId: "c1", field: "authorization", status: "unknown" }),
      buildClaim({ claimId: "c2", field: "exceptions", status: "unknown" }),
    );
    expect(readinessOf(session, "authorization").gap?.severity).toBe("blocking");
    expect(readinessOf(session, "exceptions").gap?.severity).toBe("advisory");
  });

  it("leaves a field unresolved if any one of its claims is unresolved", () => {
    const readiness = readinessOf(
      sessionWithClaims(
        buildClaim({ claimId: "c1", field: "procedure", status: "observed" }),
        buildClaim({ claimId: "c2", field: "procedure", status: "unknown" }),
        buildClaim({ claimId: "c3", field: "procedure", status: "observed" }),
      ),
      "procedure",
    );
    expect(readiness.state).toBe("unresolved");
    expect(readiness.claimCount).toBe(3);
    expect(readiness.unresolvedClaimIds).toEqual(["c2"]);
  });

  it("counts blocking and advisory gaps separately", () => {
    const report = computeGaps(
      sessionWithClaims(
        buildClaim({ claimId: "c1", field: "purpose", status: "observed" }),
        buildClaim({ claimId: "c2", field: "exceptions", status: "observed" }),
      ),
    );
    expect(report.blockingGapCount).toBe(7);
    expect(report.advisoryGapCount).toBe(4);
    expect(report.gaps).toHaveLength(11);
  });

  it("does not mutate its input", () => {
    const session = sessionWithClaims(
      buildClaim({ claimId: "c1", field: "purpose", status: "observed" }),
    );
    const before = JSON.stringify(session);
    computeGaps(session);
    expect(JSON.stringify(session)).toBe(before);
  });

  describe("askable", () => {
    it("is true for an empty field and for a conflict, false for an unknown or an extracted claim", () => {
      const session = sessionWithClaims(
        buildClaim({ claimId: "c1", field: "authorization", status: "unknown" }),
        buildClaim({ claimId: "c2", field: "roles", status: "conflict" }),
        buildClaim({ claimId: "c3", field: "trigger", status: "extracted" }),
        buildClaim({ claimId: "c4", field: "governance", status: "unknown" }),
        buildClaim({ claimId: "c5", field: "governance", status: "conflict" }),
      );
      expect(readinessOf(session, "purpose").askable).toBe(true);
      expect(readinessOf(session, "authorization").askable).toBe(false);
      expect(readinessOf(session, "roles").askable).toBe(true);
      expect(readinessOf(session, "trigger").askable).toBe(false);
      expect(readinessOf(session, "governance").askable).toBe(true);
    });

    it("is false for a resolved field", () => {
      const session = sessionWithClaims(
        buildClaim({ claimId: "c1", field: "purpose", status: "observed" }),
      );
      expect(readinessOf(session, "purpose").askable).toBe(false);
    });
  });
});
