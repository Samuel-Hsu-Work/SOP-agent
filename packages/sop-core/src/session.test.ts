import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand, type RecordClaimCommand } from "./applyClaim.ts";
import type { Claim } from "./claim.ts";
import { computeGaps } from "./computeGaps.ts";
import { MAX_MESSAGES, MAX_STATEMENT_LENGTH } from "./limits.ts";
import { createEmptySession, type SopSession, sopSessionSchema } from "./session.ts";
import type { SopFieldName } from "./sopFields.ts";
import {
  buildClaim,
  createDeterministicContext,
  createSessionWithUserMessage,
  createUserMessage,
} from "./testing.ts";

/** A session that exercises every nullable field, every history reason and both value kinds. */
function buildRichSession(): SopSession {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context, "We refund within 30 days.");
  const shared = { createdByType: "agent", sourceMessageId: messageId } as const;
  const record = (
    field: SopFieldName,
    statement: string,
    overrides: Partial<RecordClaimCommand> = {},
  ): RecordClaimCommand => ({
    kind: "record",
    ...shared,
    field,
    status: "observed",
    statement,
    note: null,
    effectiveDate: null,
    insertBeforeClaimId: null,
    ...overrides,
  });
  const applyOk = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };

  let current = applyOk(session, record("purpose", "Handle refunds.")).session;
  current = applyOk(
    current,
    record("scope", "Online orders only.", {
      status: "proposed",
      note: "Suggested.",
      effectiveDate: "2025-03-01",
    }),
  ).session;
  const first = applyOk(current, record("procedure", "Receive the request."));
  const second = applyOk(first.session, record("procedure", "Check the policy."));
  const third = applyOk(second.session, record("procedure", "Issue the refund."));
  current = third.session;

  const purpose = applyOk(current, {
    kind: "correct",
    ...shared,
    claimId: current.claims[0]?.claimId ?? "",
    statement: "Handle refunds and exchanges.",
    note: null,
    effectiveDate: null,
  });
  current = purpose.session;

  const unknown = applyOk(current, {
    kind: "markUnknown",
    ...shared,
    field: "authorization",
    claimId: null,
    note: "Approver unclear.",
  });
  current = applyOk(unknown.session, {
    kind: "correct",
    ...shared,
    claimId: unknown.claim.claimId,
    statement: "A lead approves.",
    note: null,
    effectiveDate: null,
  }).session;
  current = applyOk(current, {
    kind: "markUnknown",
    ...shared,
    field: "procedure",
    claimId: second.claim.claimId,
    note: "Not sure who checks.",
  }).session;
  current = applyOk(current, {
    kind: "withdraw",
    ...shared,
    claimId: first.claim.claimId,
    note: "Not part of this process.",
  }).session;

  return {
    ...current,
    messages: [
      ...current.messages,
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:00.000Z",
        text: "Thanks. Who approves large refunds?",
        model: "gpt-5.6-sol",
        toolCalls: [
          {
            callId: "call_1",
            toolName: "record_claim",
            field: "purpose",
            requestedStatus: "observed",
            outcome: { ok: true, claimId: "id-3", change: "created" },
          },
          {
            callId: "call_2",
            toolName: "record_claim",
            field: null,
            requestedStatus: null,
            outcome: { ok: false, code: "invalid_arguments" },
          },
        ],
      },
    ],
  };
}

describe("sopSessionSchema", () => {
  it("accepts a new empty session and reports 13 gaps for it", () => {
    const session = createEmptySession(createDeterministicContext());
    const parsed = sopSessionSchema.parse(session);
    expect(parsed).toEqual(session);
    expect(parsed.status).toBe("draft");
    expect(computeGaps(parsed).gaps).toHaveLength(13);
  });

  it("survives a JSON round trip without loss", () => {
    const session = buildRichSession();
    expect(new Set(session.claimHistory.map((entry) => entry.reason))).toEqual(
      new Set(["corrected", "answered_unknown", "marked_unknown", "withdrawn"]),
    );
    const roundTripped = sopSessionSchema.parse(JSON.parse(JSON.stringify(session)));
    expect(roundTripped).toEqual(session);
  });

  it("strips unknown keys instead of passing them through", () => {
    const session = buildRichSession();
    const tampered = {
      ...JSON.parse(JSON.stringify(session)),
      injected: "top level",
    };
    tampered.claims[0].injected = "nested";
    const parsed = sopSessionSchema.parse(tampered) as Record<string, unknown>;
    expect(parsed.injected).toBeUndefined();
    expect((parsed.claims as Record<string, unknown>[])[0]?.injected).toBeUndefined();
  });

  it("rejects a stored version-1 to 4 session, and other wrong versions and malformed timestamps", () => {
    const session = createEmptySession(createDeterministicContext());
    expect(sopSessionSchema.safeParse({ ...session, schemaVersion: 1 }).success).toBe(false);
    expect(sopSessionSchema.safeParse({ ...session, schemaVersion: 2 }).success).toBe(false);
    expect(sopSessionSchema.safeParse({ ...session, schemaVersion: 3 }).success).toBe(false);
    expect(sopSessionSchema.safeParse({ ...session, schemaVersion: 4 }).success).toBe(false);
    expect(sopSessionSchema.safeParse({ ...session, createdAt: "yesterday" }).success).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const session = buildRichSession();
    const claim = session.claims[0];
    if (claim === undefined) throw new Error("setup failed");
    expect(sopSessionSchema.safeParse({ ...session, claims: [claim, claim] }).success).toBe(false);

    const message = session.messages[0];
    if (message === undefined) throw new Error("setup failed");
    expect(sopSessionSchema.safeParse({ ...session, messages: [message, message] }).success).toBe(
      false,
    );
  });

  it("rejects a claim that cites a missing message or an assistant message", () => {
    const session = buildRichSession();
    const claim = session.claims[0];
    if (claim === undefined) throw new Error("setup failed");
    for (const messageId of ["missing", "assistant-1"]) {
      const dangling = {
        ...claim,
        source: { ...claim.source, reference: { kind: "message" as const, messageId } },
      };
      expect(sopSessionSchema.safeParse({ ...session, claims: [dangling] }).success).toBe(false);
    }
  });

  it("rejects claims that break the value and authority rules", () => {
    const session = createSessionWithUserMessage(createDeterministicContext());
    const messageId = session.messageId;
    const source = {
      type: "employee_statement" as const,
      reference: { kind: "message" as const, messageId },
    };
    const withClaim = (claim: unknown) =>
      sopSessionSchema.safeParse({ ...session.session, claims: [claim] });

    const unknownWithValue = buildClaim({
      claimId: "c1",
      field: "roles",
      status: "unknown",
      source,
    });
    expect(
      withClaim({ ...unknownWithValue, value: { kind: "statement", text: "x" } }).success,
    ).toBe(false);

    const observed = buildClaim({ claimId: "c2", field: "roles", status: "observed", source });
    expect(withClaim({ ...observed, value: null }).success).toBe(false);
    expect(withClaim({ ...observed, authority: "proposed" }).success).toBe(false);
    expect(withClaim(observed).success).toBe(true);
  });

  it("rejects a broken procedure order", () => {
    const session = buildRichSession();
    const [firstId, secondId] = session.procedureOrder;
    if (firstId === undefined || secondId === undefined) throw new Error("setup failed");
    const purposeId = session.claims.find((claim) => claim.field === "purpose")?.claimId ?? "";
    const withOrder = (procedureOrder: string[]) =>
      sopSessionSchema.safeParse({ ...session, procedureOrder }).success;

    expect(withOrder([firstId, secondId])).toBe(true);
    expect(withOrder([secondId, firstId])).toBe(true);
    expect(withOrder([firstId, firstId])).toBe(false); // repeats a step
    expect(withOrder([firstId])).toBe(false); // leaves an active step unlisted
    expect(withOrder([firstId, secondId, purposeId])).toBe(false); // lists a non-procedure claim
    expect(withOrder([firstId, secondId, "missing"])).toBe(false); // lists no claim at all
  });

  it("rejects a step outside the procedure field and a statement inside it", () => {
    const session = buildRichSession();
    const purpose = session.claims.find((claim) => claim.field === "purpose");
    if (purpose === undefined) throw new Error("setup failed");
    const asStep = { ...purpose, value: { kind: "step", text: "A step." } };
    expect(
      sopSessionSchema.safeParse({
        ...session,
        claims: session.claims.map((claim) => (claim === purpose ? asStep : claim)),
      }).success,
    ).toBe(false);

    const step = session.claims.find((claim) => claim.value?.kind === "step");
    if (step === undefined) throw new Error("setup failed");
    const asStatement = { ...step, value: { kind: "statement", text: "Not a step." } };
    expect(
      sopSessionSchema.safeParse({
        ...session,
        claims: session.claims.map((claim) => (claim === step ? asStatement : claim)),
      }).success,
    ).toBe(false);
  });

  it("rejects a history entry that cites a missing message", () => {
    const session = buildRichSession();
    const entry = session.claimHistory[0];
    if (entry === undefined) throw new Error("setup failed");
    const dangling = { ...entry, sourceMessageId: "missing" };
    expect(sopSessionSchema.safeParse({ ...session, claimHistory: [dangling] }).success).toBe(
      false,
    );
  });

  it("rejects oversized arrays and oversized text", () => {
    const session = createEmptySession(createDeterministicContext());
    const message = (index: number) => ({
      id: `m-${index}`,
      role: "user" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      text: "hello",
    });
    const tooMany = Array.from({ length: MAX_MESSAGES + 1 }, (_, index) => message(index));
    expect(sopSessionSchema.safeParse({ ...session, messages: tooMany }).success).toBe(false);

    const rich = buildRichSession();
    const claim = rich.claims[0];
    if (claim === undefined) throw new Error("setup failed");
    const longClaim = {
      ...claim,
      value: { kind: "statement" as const, text: "x".repeat(MAX_STATEMENT_LENGTH + 1) },
    };
    expect(sopSessionSchema.safeParse({ ...rich, claims: [longClaim] }).success).toBe(false);
  });

  describe("approval fields", () => {
    const empty = () => createEmptySession(createDeterministicContext());

    it("ties the approval time to the approved status in both directions", () => {
      const draft = empty();
      const at = "2026-01-02T00:00:00.000Z";
      expect(
        sopSessionSchema.safeParse({ ...draft, status: "approved", approvedAt: at }).success,
      ).toBe(true);
      expect(
        sopSessionSchema.safeParse({ ...draft, status: "approved", approvedAt: null }).success,
      ).toBe(false);
      expect(
        sopSessionSchema.safeParse({ ...draft, status: "draft", approvedAt: at }).success,
      ).toBe(false);
    });

    it("keeps the download time null on a draft and lets an approved session have one or not", () => {
      const draft = empty();
      const at = "2026-01-02T00:00:00.000Z";
      const approved = { ...draft, status: "approved" as const, approvedAt: at };
      expect(draft.downloadedAt).toBeNull();
      expect(sopSessionSchema.safeParse({ ...draft, downloadedAt: at }).success).toBe(false);
      expect(sopSessionSchema.safeParse({ ...approved, downloadedAt: null }).success).toBe(true);
      expect(sopSessionSchema.safeParse({ ...approved, downloadedAt: at }).success).toBe(true);
      expect(sopSessionSchema.safeParse({ ...approved, downloadedAt: "later" }).success).toBe(
        false,
      );
    });

    it("requires the download time, so a session without the field is not accepted", () => {
      const { downloadedAt: _omitted, ...withoutField } = empty();
      expect(sopSessionSchema.safeParse(withoutField).success).toBe(false);
    });

    it("accepts one acknowledgement per advisory field, and nothing else", () => {
      const draft = empty();
      const acknowledged = (field: string) => ({
        field,
        acknowledgedAt: "2026-01-02T00:00:00.000Z",
      });
      const parse = (advisoryAcknowledgements: unknown[]) =>
        sopSessionSchema.safeParse({ ...draft, advisoryAcknowledgements }).success;

      expect(parse([acknowledged("exceptions"), acknowledged("controls")])).toBe(true);
      expect(parse([acknowledged("exceptions"), acknowledged("exceptions")])).toBe(false);
      expect(parse([acknowledged("purpose")])).toBe(false); // a blocking field cannot be acknowledged
      expect(parse([{ field: "exceptions" }])).toBe(false);
      expect(
        parse(
          ["exceptions", "evidence", "controls", "decisionRules", "prerequisites", "x"].map(
            acknowledged,
          ),
        ),
      ).toBe(false);
    });
  });

  describe("history entries", () => {
    function sessionWithOneEntry() {
      const session = buildRichSession();
      const entry = session.claimHistory[0];
      if (entry === undefined) throw new Error("setup failed");
      return { session, entry };
    }
    const parseWith = (session: SopSession, claimHistory: unknown[]) =>
      sopSessionSchema.safeParse({ ...session, claimHistory }).success;

    it("attributes a review action to the user with no message, and an agent change to a message", () => {
      const { session, entry } = sessionWithOneEntry();
      expect(parseWith(session, [entry])).toBe(true);

      const review = { ...entry, changedBy: "user", sourceMessageId: null, reason: "confirmed" };
      expect(parseWith(session, [review])).toBe(true);
      expect(parseWith(session, [{ ...review, reason: "rejected" }])).toBe(true);
    });

    it("rejects a review action that cites a message or is attributed to the agent", () => {
      const { session, entry } = sessionWithOneEntry();
      const review = { ...entry, changedBy: "user", sourceMessageId: null, reason: "confirmed" };
      expect(parseWith(session, [{ ...review, sourceMessageId: entry.sourceMessageId }])).toBe(
        false,
      );
      expect(parseWith(session, [{ ...review, changedBy: "agent" }])).toBe(false);
    });

    it("rejects an agent change with no message, and a user attribution for a non-review reason", () => {
      const { session, entry } = sessionWithOneEntry();
      expect(parseWith(session, [{ ...entry, sourceMessageId: null }])).toBe(false);
      expect(parseWith(session, [{ ...entry, changedBy: "user" }])).toBe(false);
    });
  });

  it("does not let a confirmed claim keep the authority of an unreviewed suggestion", () => {
    const { session, messageId } = createSessionWithUserMessage(createDeterministicContext());
    const source = {
      type: "agent_suggestion" as const,
      reference: { kind: "message" as const, messageId },
    };
    const confirmed = (authority: string) =>
      sopSessionSchema.safeParse({
        ...session,
        claims: [
          buildClaim({
            claimId: "c1",
            field: "roles",
            status: "confirmed",
            source,
            authority: authority as never,
          }),
        ],
      }).success;

    expect(confirmed("observed_practice")).toBe(true);
    expect(confirmed("official_policy")).toBe(true);
    expect(confirmed("proposed")).toBe(false);
    expect(confirmed("unknown")).toBe(false);
  });
});

describe("document sources and conflicts", () => {
  const empty = () => createEmptySession(createDeterministicContext());
  const documentSource = {
    type: "policy_document" as const,
    reference: {
      kind: "document" as const,
      citation: {
        documentName: "policy.pdf",
        location: "p.2",
        quote: "Refunds over $200 need approval.",
      },
    },
  };
  const extracted = (overrides: Partial<Claim> = {}): Claim =>
    buildClaim({ claimId: "e1", field: "authorization", status: "extracted", ...overrides });
  // `buildClaim` cites "message-1", so the session holds that user message.
  const withClaims = (claims: Claim[]): SopSession => ({
    ...empty(),
    messages: [createUserMessage("message-1")],
    claims,
  });

  it("accepts an extracted claim that cites a document and no message", () => {
    expect(sopSessionSchema.safeParse(withClaims([extracted()])).success).toBe(true);
  });

  it("requires an extracted claim to come from a document, by extraction, with policy authority", () => {
    const parse = (claim: Claim) => sopSessionSchema.safeParse(withClaims([claim])).success;
    expect(
      parse(
        extracted({
          source: { type: "employee_statement", reference: { kind: "message", messageId: "m" } },
        }),
      ),
    ).toBe(false);
    expect(parse(extracted({ authority: "observed_practice" }))).toBe(false);
    expect(parse(extracted({ createdByType: "agent" }))).toBe(false);
  });

  it("ties a document source to a document reference, and every other source to a message", () => {
    const messageSourceWithDocumentType = {
      type: "policy_document" as const,
      reference: { kind: "message" as const, messageId: "m" },
    };
    const documentReferenceWithStatementType = {
      type: "employee_statement" as const,
      reference: documentSource.reference,
    };
    const parse = (claim: Claim) => sopSessionSchema.safeParse(withClaims([claim])).success;
    expect(parse(extracted({ source: messageSourceWithDocumentType }))).toBe(false);
    expect(
      parse(
        buildClaim({ claimId: "o", field: "scope", source: documentReferenceWithStatementType }),
      ),
    ).toBe(false);
  });

  it("rejects a citation with a short quote", () => {
    const shortQuote = extracted({
      source: {
        ...documentSource,
        reference: {
          kind: "document",
          citation: { ...documentSource.reference.citation, quote: "short" },
        },
      },
    });
    expect(sopSessionSchema.safeParse(withClaims([shortQuote])).success).toBe(false);
  });

  it("accepts a conflict only as a pair in one field that name each other", () => {
    const pair = (overrides: Partial<Claim> = {}) => [
      extracted({ claimId: "a", status: "conflict", conflictsWithClaimId: "b" }),
      buildClaim({
        claimId: "b",
        field: "authorization",
        status: "conflict",
        conflictsWithClaimId: "a",
        ...overrides,
      }),
    ];
    const parse = (claims: Claim[]) => sopSessionSchema.safeParse(withClaims(claims)).success;

    // The document side of a conflict keeps its source, authority and creator.
    expect(parse(pair())).toBe(true);
    expect(parse([pair()[0] as Claim])).toBe(false);
    expect(parse(pair({ field: "controls" }))).toBe(false);
    expect(parse(pair({ conflictsWithClaimId: "b" }))).toBe(false);
    expect(parse(pair({ conflictsWithClaimId: null, status: "observed" }))).toBe(false);
  });

  it("gives a claim a partner only while it is in conflict", () => {
    const parse = (claim: Claim) => sopSessionSchema.safeParse(withClaims([claim])).success;
    expect(parse(buildClaim({ claimId: "x", field: "scope", conflictsWithClaimId: "y" }))).toBe(
      false,
    );
  });

  it("lets a found conflict be a system act with no message, and nothing else be", () => {
    const claim = buildClaim({ claimId: "c", field: "scope" });
    const entry = (overrides: object) => ({
      entryId: "h",
      claimId: "c",
      changedAt: "2026-01-01T00:00:00.000Z",
      changedBy: "system",
      sourceMessageId: null,
      reason: "conflict_detected",
      changeNote: null,
      previousClaim: claim,
      ...overrides,
    });
    const parse = (history: object) =>
      sopSessionSchema.safeParse({ ...withClaims([claim]), claimHistory: [history] }).success;

    expect(parse(entry({}))).toBe(true);
    expect(parse(entry({ sourceMessageId: "m" }))).toBe(false);
    expect(parse(entry({ changedBy: "agent" }))).toBe(false);
    expect(parse(entry({ reason: "corrected" }))).toBe(false);
  });
});
