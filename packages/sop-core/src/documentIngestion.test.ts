import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand } from "./applyClaim.ts";
import { type Claim, type DocumentCitation, totalClaimTextLength } from "./claim.ts";
import { buildInterviewAgenda } from "./interviewAgenda.ts";
import { MAX_CLAIMS } from "./limits.ts";
import type { SopSession } from "./session.ts";
import { sopSessionSchema } from "./session.ts";
import { buildSopDocument } from "./sopDocument.ts";
import type { SopFieldName } from "./sopFields.ts";
import { createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

const POLICY_STATEMENT =
  "Vendor payments above $10,000 require written approval from the budget owner and the CFO.";
const MEMO_STATEMENT =
  "Vendor payments up to $25,000 need the approval of the Finance Director only.";

function citation(documentName: string, location: string, quote?: string): DocumentCitation {
  return { documentName, location, quote: quote ?? `A quote from ${documentName} at ${location}.` };
}

function setup() {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context, "We follow the policy.");

  const applyOk = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };
  const ingest = (
    current: SopSession,
    field: SopFieldName,
    statement: string,
    from: DocumentCitation,
  ) =>
    applyOk(current, {
      kind: "ingestExtracted",
      createdByType: "extraction",
      field,
      statement,
      citation: from,
      effectiveDate: null,
      note: null,
    });
  const record = (
    current: SopSession,
    field: SopFieldName,
    statement: string,
    status: "observed" | "proposed" = "observed",
  ) =>
    applyOk(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status,
      statement,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId: null,
    });
  return { context, session, messageId, applyOk, ingest, record };
}

const claimOf = (session: SopSession, claimId: string): Claim => {
  const claim = session.claims.find((candidate) => candidate.claimId === claimId);
  if (claim === undefined) throw new Error("no such claim");
  return claim;
};

describe("ingestExtracted", () => {
  it("writes an extracted claim whose status, source, authority and creator are derived by code", () => {
    const { session, ingest } = setup();
    const empty: SopSession = { ...session, messages: [] };
    const result = ingest(
      empty,
      "authorization",
      POLICY_STATEMENT,
      citation("vendor-payment-policy.md", "§ Approval authority"),
    );

    expect(result.change).toBe("created");
    expect(result.claim).toMatchObject({
      field: "authorization",
      status: "extracted",
      authority: "official_policy",
      createdByType: "extraction",
      conflictsWithClaimId: null,
      value: { kind: "statement", text: POLICY_STATEMENT },
      source: {
        type: "policy_document",
        reference: {
          kind: "document",
          citation: { documentName: "vendor-payment-policy.md", location: "§ Approval authority" },
        },
      },
    });
    // It cites no message, so a session with no messages at all is still valid.
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
    expect(result.session.claimHistory).toEqual([]);
  });

  it("gives an extracted procedure step a place at the end of the procedure", () => {
    const { session, ingest, record } = setup();
    const withStep = record(session, "procedure", "Receive the request.").session;
    const result = ingest(
      withStep,
      "procedure",
      "Check the invoice.",
      citation("policy.md", "p.1"),
    );

    expect(result.claim.value).toEqual({ kind: "step", text: "Check the invoice." });
    expect(result.session.procedureOrder).toHaveLength(2);
    expect(result.session.procedureOrder[1]).toBe(result.claim.claimId);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("adds nothing when the same rule from the same place is ingested again", () => {
    const { session, ingest } = setup();
    const from = citation("policy.md", "p.2");
    const first = ingest(session, "scope", "Applies to online orders.", from);
    const again = applyClaim(
      first.session,
      {
        kind: "ingestExtracted",
        createdByType: "extraction",
        field: "scope",
        statement: "  applies to ONLINE orders. ",
        citation: from,
        effectiveDate: null,
        note: null,
      },
      createDeterministicContext(),
    );

    expect(again.ok && again.change).toBe("unchanged");
    expect(again.ok && again.session).toBe(first.session);
  });

  it("refuses a bad citation, an empty statement and a bad date, and leaves the session alone", () => {
    const { session, context } = setup();
    const base = {
      kind: "ingestExtracted" as const,
      createdByType: "extraction" as const,
      field: "scope" as const,
      statement: "Applies to online orders.",
      citation: citation("policy.md", "p.1"),
      effectiveDate: null,
      note: null,
    };
    const failCode = (command: ClaimWriteCommand) => {
      const result = applyClaim(session, command, context);
      return result.ok ? "ok" : result.error.code;
    };

    expect(failCode({ ...base, citation: { ...base.citation, quote: "too short" } })).toBe(
      "invalid_value",
    );
    expect(failCode({ ...base, citation: { ...base.citation, location: "" } })).toBe(
      "invalid_value",
    );
    expect(failCode({ ...base, statement: "   " })).toBe("value_required");
    expect(failCode({ ...base, effectiveDate: "last year" })).toBe("invalid_value");
  });

  it("cannot be built by anyone but extraction, and never on an approved session", () => {
    const { session, context } = setup();
    const command = {
      kind: "ingestExtracted" as const,
      field: "scope" as const,
      statement: "Applies to online orders.",
      citation: citation("policy.md", "p.1"),
      effectiveDate: null,
      note: null,
    };
    const forged = applyClaim(
      session,
      { ...command, createdByType: "user" } as unknown as ClaimWriteCommand,
      context,
    );
    expect(forged.ok ? "ok" : forged.error.code).toBe("status_not_allowed_for_creator");

    const approved: SopSession = {
      ...session,
      status: "approved",
      approvedAt: "2026-01-02T00:00:00.000Z",
    };
    const refused = applyClaim(approved, { ...command, createdByType: "extraction" }, context);
    expect(refused.ok ? "ok" : refused.error.code).toBe("session_approved");
  });

  it("respects the claim limit and counts the citation in the session's text budget", () => {
    const { session, ingest, context } = setup();
    const full: SopSession = {
      ...session,
      claims: Array.from(
        { length: MAX_CLAIMS },
        (_, index) =>
          ingest(session, "scope", `Rule ${index}`, citation("policy.md", `p.${index}`)).claim,
      ),
    };
    const result = applyClaim(
      full,
      {
        kind: "ingestExtracted",
        createdByType: "extraction",
        field: "scope",
        statement: "One more rule.",
        citation: citation("policy.md", "p.999"),
        effectiveDate: null,
        note: null,
      },
      context,
    );
    expect(result.ok ? "ok" : result.error.code).toBe("session_limit_reached");

    const one = ingest(session, "scope", "Rule.", citation("a.md", "p.1", "q".repeat(100))).claim;
    expect(totalClaimTextLength([one])).toBe("Rule.".length + "a.md".length + "p.1".length + 100);
  });
});

describe("conflict detection", () => {
  it("flags a document claim against a later document claim with a different figure", () => {
    const { session, ingest } = setup();
    const policy = ingest(
      session,
      "authorization",
      POLICY_STATEMENT,
      citation("vendor-payment-policy.md", "§ Approval authority"),
    );
    const memo = ingest(
      policy.session,
      "authorization",
      MEMO_STATEMENT,
      citation("vendor-payment-memo.md", "§ Approval authority"),
    );

    expect(memo.claim).toMatchObject({
      status: "conflict",
      conflictsWithClaimId: policy.claim.claimId,
    });
    expect(claimOf(memo.session, policy.claim.claimId)).toMatchObject({
      status: "conflict",
      conflictsWithClaimId: memo.claim.claimId,
    });
    // Both sides keep their own words, source and authority.
    expect(claimOf(memo.session, policy.claim.claimId).value?.text).toBe(POLICY_STATEMENT);
    expect(memo.claim.value?.text).toBe(MEMO_STATEMENT);
    expect(memo.claim.authority).toBe("official_policy");

    // Flagging is never silent: one history entry per side, by the system, holding the earlier claim.
    const entries = memo.session.claimHistory.filter(
      (entry) => entry.reason === "conflict_detected",
    );
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({ changedBy: "system", sourceMessageId: null });
      expect(entry.previousClaim.status).toBe("extracted");
    }
    expect(sopSessionSchema.safeParse(memo.session).success).toBe(true);
  });

  it("flags a document claim against something the user said, whichever came first", () => {
    const { session, ingest, record } = setup();
    const document = citation("vendor-payment-policy.md", "§ Approval authority");

    const documentFirst = record(
      ingest(session, "authorization", POLICY_STATEMENT, document).session,
      "authorization",
      "Payments up to $25,000 need only the Finance Director.",
    );
    expect(documentFirst.claim.status).toBe("conflict");

    const userFirst = ingest(
      record(session, "authorization", "Payments up to $25,000 need only the Finance Director.")
        .session,
      "authorization",
      POLICY_STATEMENT,
      document,
    );
    expect(userFirst.claim.status).toBe("conflict");
    expect(userFirst.session.claims.filter((claim) => claim.status === "conflict")).toHaveLength(2);
  });

  it("does not flag a handbook that lists two limits, or two things the user said", () => {
    const { session, ingest, record } = setup();
    const handbook = citation("expense-handbook.docx", "§ Approvals");
    const ladder = ingest(
      ingest(session, "authorization", "Expenses up to $500 need manager approval.", handbook)
        .session,
      "authorization",
      "Expenses up to $5,000 need director approval.",
      { ...handbook, location: "§ Approvals (2)" },
    );
    expect(ladder.session.claims.map((claim) => claim.status)).toEqual(["extracted", "extracted"]);

    const spoken = record(
      record(session, "authorization", "Refunds over $200 need the shift lead.").session,
      "authorization",
      "Refunds over $300 need the shift lead.",
    );
    expect(spoken.session.claims.map((claim) => claim.status)).toEqual(["observed", "observed"]);
  });

  it("does not flag a suggestion, another field, or unrelated words", () => {
    const { session, ingest, record } = setup();
    const document = citation("policy.md", "p.1");
    const documentClaim = ingest(session, "authorization", POLICY_STATEMENT, document).session;

    const suggestion = record(
      documentClaim,
      "authorization",
      "Payments up to $25,000 need only the Finance Director.",
      "proposed",
    );
    expect(suggestion.claim.status).toBe("proposed");

    const otherField = record(documentClaim, "controls", "Payments up to $25,000 are logged.");
    expect(otherField.claim.status).toBe("observed");

    const unrelated = record(documentClaim, "authorization", "Refund requests arrive by email.");
    expect(unrelated.claim.status).toBe("observed");
  });

  it("flags the same figure when a different person approves it, and a restatement too", () => {
    const { session, ingest, record } = setup();
    const document = ingest(
      session,
      "authorization",
      "The CFO approves payments above $10,000.",
      citation("policy.md", "p.1"),
    ).session;

    const otherApprover = record(
      document,
      "authorization",
      "The department manager approves payments above $10,000.",
    );
    expect(otherApprover.claim.status).toBe("conflict");

    // Words alone cannot tell a restatement from a contradiction, so it is flagged as well.
    const restatement = record(document, "authorization", "Payments above $10,000 need the CFO.");
    expect(restatement.claim.status).toBe("conflict");
  });

  it("flags two statements about the same thing when they name different people, with no numbers", () => {
    const { session, ingest, record } = setup();
    const result = record(
      ingest(
        session,
        "roles",
        "The shift lead approves refunds.",
        citation("handbook.md", "§ Roles"),
      ).session,
      "roles",
      "The support manager approves refunds.",
    );
    expect(result.claim.status).toBe("conflict");
  });

  it("puts a claim in at most one pair", () => {
    const { session, ingest, record } = setup();
    const first = ingest(session, "authorization", POLICY_STATEMENT, citation("a.md", "p.1"));
    const second = ingest(first.session, "authorization", MEMO_STATEMENT, citation("b.md", "p.1"));
    const third = record(
      second.session,
      "authorization",
      "Payments up to $50,000 need only the Finance Director.",
    );

    expect(third.claim.status).toBe("observed");
    expect(third.session.claims.filter((claim) => claim.status === "conflict")).toHaveLength(2);
  });

  it("does not let the agent, or a person's review, act on a claim that is in conflict", () => {
    const { session, ingest, applyOk, messageId, context } = setup();
    const first = ingest(session, "authorization", POLICY_STATEMENT, citation("a.md", "p.1"));
    const second = ingest(first.session, "authorization", MEMO_STATEMENT, citation("b.md", "p.1"));
    const conflicted = second.session;
    const id = second.claim.claimId;

    const code = (command: ClaimWriteCommand) => {
      const result = applyClaim(conflicted, command, context);
      return result.ok ? "ok" : result.error.code;
    };
    expect(code({ kind: "confirm", createdByType: "user", claimId: id })).toBe(
      "review_action_not_allowed",
    );
    expect(code({ kind: "reject", createdByType: "user", claimId: id })).toBe(
      "review_action_not_allowed",
    );
    expect(
      code({
        kind: "correct",
        createdByType: "agent",
        claimId: id,
        statement: "Something else.",
        note: null,
        effectiveDate: null,
        sourceMessageId: messageId,
      }),
    ).toBe("status_transition_not_allowed");
    expect(
      code({
        kind: "withdraw",
        createdByType: "agent",
        claimId: id,
        note: "No.",
        sourceMessageId: messageId,
      }),
    ).toBe("status_transition_not_allowed");
    expect(applyOk).toBeDefined();
  });
});

describe("resolveConflict", () => {
  function conflicted() {
    const { session, ingest, record, applyOk, messageId, context } = setup();
    const document = ingest(
      session,
      "authorization",
      POLICY_STATEMENT,
      citation("vendor-payment-policy.md", "§ Approval authority"),
    );
    const spoken = record(
      document.session,
      "authorization",
      "Payments up to $25,000 need only the Finance Director.",
    );
    return {
      session: spoken.session,
      document: document.claim,
      spoken: spoken.claim,
      ingest,
      applyOk,
      messageId,
      context,
    };
  }

  it("records the user's final answer as one observed claim and moves both sides to the history", () => {
    const { session, document, spoken, applyOk, messageId } = conflicted();
    const result = applyOk(session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: spoken.claimId,
      statement: "Payments up to $25,000 need the Finance Director; above that, the CFO too.",
      note: "The memo replaced the old threshold.",
      effectiveDate: "2025-06-15",
      sourceMessageId: messageId,
    });

    expect(result.claim).toMatchObject({
      status: "observed",
      authority: "observed_practice",
      conflictsWithClaimId: null,
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
      effectiveDate: "2025-06-15",
    });
    expect(result.session.claims).toEqual([result.claim]);

    const resolved = result.session.claimHistory.filter(
      (entry) => entry.reason === "conflict_resolved",
    );
    expect(resolved.map((entry) => entry.claimId).sort()).toEqual(
      [document.claimId, spoken.claimId].sort(),
    );
    for (const entry of resolved) {
      expect(entry).toMatchObject({ changedBy: "agent", sourceMessageId: messageId });
      expect(entry.previousClaim.status).toBe("conflict");
    }
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("checks the user's answer against a third claim that was left out of the first pair", () => {
    const { session, document, spoken, ingest, applyOk, messageId } = conflicted();
    // Both of the third claim's possible partners are already paired, so it stays unflagged.
    const third = ingest(
      session,
      "authorization",
      "Payments up to $50,000 need the CFO.",
      citation("handbook.md", "§ Payments"),
    );
    expect(third.claim.status).toBe("extracted");

    const result = applyOk(third.session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: spoken.claimId,
      statement: "Payments up to $25,000 need only the Finance Director.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
    });

    expect(result.session.claims.map((claim) => claim.status).sort()).toEqual([
      "conflict",
      "conflict",
    ]);
    expect(result.session.claims.every((claim) => claim.claimId !== document.claimId)).toBe(true);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("gives the same result from either member of the pair", () => {
    const { session, document, spoken, applyOk, messageId } = conflicted();
    const command = (claimId: string): ClaimWriteCommand => ({
      kind: "resolveConflict",
      createdByType: "agent",
      claimId,
      statement: "Both apply.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
    });
    const fromDocument = applyOk(session, command(document.claimId));
    const fromSpoken = applyOk(session, command(spoken.claimId));
    expect(fromDocument.session.claims).toHaveLength(1);
    expect(fromDocument.session.claims.map((claim) => claim.value)).toEqual(
      fromSpoken.session.claims.map((claim) => claim.value),
    );
  });

  it("puts the answer in the earlier member's place in the procedure and drops the other", () => {
    const { session, ingest, record, applyOk, messageId } = setup();
    let current = record(session, "procedure", "Receive the request.").session;
    current = record(current, "procedure", "Approve payments above $10,000 with the CFO.").session;
    const step = record(current, "procedure", "Send the confirmation.");
    current = step.session;
    // The document's step is added at the end, then flagged against the second step.
    const documentStep = ingest(
      current,
      "procedure",
      "Approve payments up to $25,000 with the Finance Director.",
      citation("memo.md", "§ Steps"),
    );
    expect(documentStep.claim.status).toBe("conflict");

    const result = applyOk(documentStep.session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: documentStep.claim.claimId,
      statement: "Approve payments with the Finance Director, or the CFO above $25,000.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
    });
    const texts = result.session.procedureOrder.map(
      (claimId) => claimOf(result.session, claimId).value?.text,
    );
    expect(texts).toEqual([
      "Receive the request.",
      "Approve payments with the Finance Director, or the CFO above $25,000.",
      "Send the confirmation.",
    ]);
    expect(sopSessionSchema.safeParse(result.session).success).toBe(true);
  });

  it("refuses a claim that is not in a conflict, a missing claim, a missing message and an empty answer", () => {
    const { session, spoken, document, messageId, context } = conflicted();
    const { session: quiet, record } = setup();
    const observed = record(quiet, "scope", "Online orders.");
    const code = (
      target: SopSession,
      command: Partial<ClaimWriteCommand> & { claimId: string },
    ) => {
      const result = applyClaim(
        target,
        {
          kind: "resolveConflict",
          createdByType: "agent",
          statement: "Final answer.",
          note: null,
          effectiveDate: null,
          sourceMessageId: messageId,
          ...command,
        } as ClaimWriteCommand,
        context,
      );
      return result.ok ? "ok" : result.error.code;
    };

    expect(code(observed.session, { claimId: observed.claim.claimId })).toBe(
      "status_transition_not_allowed",
    );
    expect(code(session, { claimId: "nope" })).toBe("target_claim_not_found");
    expect(code(session, { claimId: spoken.claimId, sourceMessageId: "missing" } as never)).toBe(
      "source_message_not_found",
    );
    expect(code(session, { claimId: document.claimId, statement: "  " } as never)).toBe(
      "value_required",
    );
  });

  it("refuses on an approved session", () => {
    const { session, spoken, messageId, context } = conflicted();
    const approved: SopSession = {
      ...session,
      status: "approved",
      approvedAt: "2026-01-02T00:00:00.000Z",
    };
    const result = applyClaim(
      approved,
      {
        kind: "resolveConflict",
        createdByType: "agent",
        claimId: spoken.claimId,
        statement: "Final answer.",
        note: null,
        effectiveDate: null,
        sourceMessageId: messageId,
      },
      context,
    );
    expect(result.ok ? "ok" : result.error.code).toBe("session_approved");
  });
});

function conflictedForReupload() {
  const { session, ingest, record, applyOk, messageId } = setup();
  const document = ingest(
    session,
    "authorization",
    POLICY_STATEMENT,
    citation("vendor-payment-policy.md", "§ Approval authority"),
  );
  const spoken = record(
    document.session,
    "authorization",
    "Payments up to $25,000 need only the Finance Director.",
  );
  return {
    session: spoken.session,
    document: document.claim,
    spoken: spoken.claim,
    ingest,
    applyOk,
    messageId,
  };
}

describe("uploading a document again after a rule was rejected", () => {
  const rejectOnly = (
    session: SopSession,
    claimId: string,
    applyOk: ReturnType<typeof setup>["applyOk"],
  ) => applyOk(session, { kind: "reject", createdByType: "user", claimId });

  it("does not bring back a rejected rule that was the only claim of its field", () => {
    const { session, ingest, applyOk } = setup();
    const source = citation("policy.md", "p.2");
    const extracted = ingest(session, "scope", "Applies to online orders.", source);
    const rejected = rejectOnly(extracted.session, extracted.claim.claimId, applyOk);

    const again = ingest(rejected.session, "scope", "Applies to online orders.", source);
    expect(again.change).toBe("unchanged");
    expect(again.session).toBe(rejected.session);
    expect(again.session.claims.map((claim) => claim.status)).toEqual(["unknown"]);
  });

  it("does not bring back a rejected rule that was removed to the history", () => {
    const { session, ingest, record, applyOk } = setup();
    const source = citation("policy.md", "p.2");
    const spoken = record(session, "scope", "Covers the whole company.");
    const extracted = ingest(spoken.session, "scope", "Applies to online orders.", source);
    const rejected = rejectOnly(extracted.session, extracted.claim.claimId, applyOk);
    expect(rejected.session.claims).toHaveLength(1);

    const again = ingest(rejected.session, "scope", "Applies to online orders.", source);
    expect(again.change).toBe("unchanged");
    expect(again.session.claims).toHaveLength(1);
  });

  it("does not bring back a document rule whose conflict the user already answered", () => {
    const { session, document, spoken, ingest, applyOk, messageId } = conflictedForReupload();
    const resolved = applyOk(session, {
      kind: "resolveConflict",
      createdByType: "agent",
      claimId: spoken.claimId,
      statement: "Payments up to $25,000 need only the Finance Director.",
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
    });
    expect(resolved.session.claims).toHaveLength(1);

    const again = ingest(
      resolved.session,
      "authorization",
      POLICY_STATEMENT,
      citation("vendor-payment-policy.md", "§ Approval authority"),
    );
    expect(again.change).toBe("unchanged");
    expect(again.session.claims).toHaveLength(1);
    expect(again.session.claims.some((claim) => claim.claimId === document.claimId)).toBe(false);
  });

  it("still adds a different rule from the same place", () => {
    const { session, ingest, applyOk } = setup();
    const source = citation("policy.md", "p.2");
    const extracted = ingest(session, "scope", "Applies to online orders.", source);
    const rejected = rejectOnly(extracted.session, extracted.claim.claimId, applyOk);
    const other = ingest(rejected.session, "scope", "Applies to store orders too.", source);
    expect(other.change).toBe("created");
  });
});

describe("review of a claim that came from a document", () => {
  it("confirms it keeping its citation, and a rejection keeps the citation on the unknown", () => {
    const { session, ingest, applyOk } = setup();
    const document = citation("policy.md", "p.2");
    const extracted = ingest(session, "scope", "Applies to online orders.", document);

    const confirmed = applyOk(extracted.session, {
      kind: "confirm",
      createdByType: "user",
      claimId: extracted.claim.claimId,
    });
    expect(confirmed.claim).toMatchObject({
      status: "confirmed",
      authority: "official_policy",
      source: { type: "policy_document", reference: { kind: "document", citation: document } },
    });
    expect(sopSessionSchema.safeParse(confirmed.session).success).toBe(true);

    const rejected = applyOk(extracted.session, {
      kind: "reject",
      createdByType: "user",
      claimId: extracted.claim.claimId,
    });
    expect(rejected.claim).toMatchObject({ status: "unknown", value: null, authority: "unknown" });
    expect(rejected.claim.source.reference).toEqual({ kind: "document", citation: document });
    expect(sopSessionSchema.safeParse(rejected.session).success).toBe(true);
  });
});

describe("the interview agenda around documents", () => {
  it("does not ask about a field that only holds an extracted claim", () => {
    const { session, ingest } = setup();
    const extracted = ingest(
      session,
      "scope",
      "Applies to online orders.",
      citation("p.md", "p.1"),
    );
    const agenda = buildInterviewAgenda(extracted.session);
    expect(agenda.askNext.map((question) => question.field)).not.toContain("scope");
    expect(agenda.doNotAsk).toContainEqual({ field: "scope", why: "awaiting_review" });
  });

  it("asks about a conflict first within its class, with both sides and who said each", () => {
    const { session, ingest, record } = setup();
    const withConflict = record(
      ingest(session, "authorization", POLICY_STATEMENT, citation("policy.md", "p.1")).session,
      "authorization",
      "Payments up to $25,000 need only the Finance Director.",
    ).session;
    const agenda = buildInterviewAgenda(withConflict);

    expect(agenda.askNext[0]).toMatchObject({ field: "authorization", reason: "conflict" });
    const sides = agenda.askNext[0]?.conflict?.sides ?? [];
    expect(sides.map((side) => side.sourceLabel).sort()).toEqual([
      "an uploaded document",
      "what the user said",
    ]);
    expect(JSON.stringify(sides)).not.toContain("policy.md");
    expect(agenda.readyToReview).toBe(false);
  });
});

describe("the SOP document around documents", () => {
  it("says where a document claim came from, carries its citation, and pairs a conflict", () => {
    const { session, ingest } = setup();
    const from = citation(
      "refund-policy.pdf",
      "p.2",
      "Refunds under 50 are approved automatically.",
    );
    const extracted = ingest(session, "decisionRules", "Approve automatically under 50.", from);
    const section = buildSopDocument(extracted.session).sections.find(
      (candidate) => candidate.field === "decisionRules",
    );
    expect(section?.items[0]).toMatchObject({
      status: "extracted",
      sourceType: "policy_document",
      sourceLine: "from refund-policy.pdf, p.2",
      citation: from,
      conflictsWithClaimId: null,
    });

    const first = ingest(session, "authorization", POLICY_STATEMENT, citation("a.md", "p.1"));
    const second = ingest(first.session, "authorization", MEMO_STATEMENT, citation("b.md", "p.1"));
    const items =
      buildSopDocument(second.session).sections.find(
        (candidate) => candidate.field === "authorization",
      )?.items ?? [];
    expect(items.map((item) => item.conflictsWithClaimId).sort()).toEqual(
      [first.claim.claimId, second.claim.claimId].sort(),
    );
  });
});
