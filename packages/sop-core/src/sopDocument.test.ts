import { describe, expect, it } from "vitest";
import { applyClaim, type ClaimWriteCommand } from "./applyClaim.ts";
import { approveSession, setAdvisoryAcknowledgement } from "./approval.ts";
import type { Claim, ClaimStatus } from "./claim.ts";
import type { SopSession } from "./session.ts";
import {
  buildSopDocument,
  PROVENANCE_TAGS,
  SOP_DOCUMENT_TITLE,
  SOP_DOCUMENT_VERSION,
} from "./sopDocument.ts";
import { SOP_FIELD_NAMES, type SopFieldName } from "./sopFields.ts";
import { buildClaim, createDeterministicContext, createSessionWithUserMessage } from "./testing.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function setup() {
  const context = createDeterministicContext();
  const { session, messageId } = createSessionWithUserMessage(context);
  const apply = (current: SopSession, command: ClaimWriteCommand) => {
    const result = applyClaim(current, command, context);
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result;
  };
  const record = (
    current: SopSession,
    field: SopFieldName,
    statement: string,
    status: "observed" | "proposed" = "observed",
    insertBeforeClaimId: string | null = null,
  ) =>
    apply(current, {
      kind: "record",
      createdByType: "agent",
      field,
      status,
      statement,
      note: null,
      effectiveDate: null,
      sourceMessageId: messageId,
      insertBeforeClaimId,
    });
  const handBuilt = (status: ClaimStatus, overrides: Partial<Claim> = {}): Claim =>
    buildClaim({
      claimId: `built-${status}`,
      field: "roles",
      status,
      source: { type: "employee_statement", reference: { kind: "message", messageId } },
      ...overrides,
    });
  return { context, session, messageId, apply, record, handBuilt };
}

const sectionOf = (document: ReturnType<typeof buildSopDocument>, field: SopFieldName) => {
  const section = document.sections.find((entry) => entry.field === field);
  if (section === undefined) throw new Error(`no section ${field}`);
  return section;
};

describe("buildSopDocument", () => {
  it("has the fixed title and version, and all 13 sections blocking first, even for an empty session", () => {
    const { session } = setup();
    const document = buildSopDocument(session);

    expect(document).toMatchObject({
      title: SOP_DOCUMENT_TITLE,
      version: SOP_DOCUMENT_VERSION,
      status: "draft",
      approvedAt: null,
      legend: [],
      counts: { blockingGaps: 8, advisoryGaps: 5, confirmedClaims: 0, totalClaims: 0 },
    });
    expect(document.sections.map((section) => section.field)).toEqual([...SOP_FIELD_NAMES]);
    expect(document.sections[0]).toMatchObject({
      heading: "Purpose",
      fieldClass: "blocking",
      gapNotice: "Nothing has been recorded for this section.",
      items: [],
    });
  });

  it("prints the procedure in step order, including a step inserted before another", () => {
    const { session, record } = setup();
    const last = record(session, "procedure", "Issue the refund.");
    const first = record(
      last.session,
      "procedure",
      "Receive the request.",
      "observed",
      last.claim.claimId,
    );
    const items = sectionOf(buildSopDocument(first.session), "procedure").items;
    expect(items.map((item) => [item.position, item.text])).toEqual([
      [1, "Receive the request."],
      [2, "Issue the refund."],
    ]);
  });

  it("puts a whole-procedure unknown after the steps, with no step number", () => {
    const { session, record, apply, messageId } = setup();
    const withStep = record(session, "procedure", "Receive the request.").session;
    const withUnknown = apply(withStep, {
      kind: "markUnknown",
      createdByType: "agent",
      field: "procedure",
      claimId: null,
      note: "Who checks the order.",
      sourceMessageId: messageId,
    }).session;
    const items = sectionOf(buildSopDocument(withUnknown), "procedure").items;
    expect(items.map((item) => [item.position, item.status])).toEqual([
      [1, "observed"],
      [null, "unknown"],
    ]);
  });

  it("tags every status with its own name in brackets, and marks the open ones", () => {
    const { session, handBuilt } = setup();
    const statuses: ClaimStatus[] = [
      "confirmed",
      "observed",
      "proposed",
      "unknown",
      "conflict",
      "extracted",
    ];
    const claims = statuses.map((status) =>
      handBuilt(status, {
        field: "controls",
        claimId: `c-${status}`,
        authority:
          status === "unknown"
            ? "unknown"
            : status === "proposed"
              ? "proposed"
              : "observed_practice",
        source: {
          type: status === "proposed" ? "agent_suggestion" : "employee_statement",
          reference: { kind: "message", messageId: "message-1" },
        },
      }),
    );
    const document = buildSopDocument({ ...session, claims });
    const items = sectionOf(document, "controls").items;

    expect(items.map((item) => item.provenanceTag)).toEqual(
      statuses.map((status) => `[${status}]`),
    );
    expect(items.map((item) => item.provenanceTag)).toEqual(
      statuses.map((status) => PROVENANCE_TAGS[status]),
    );
    expect(items.map((item) => [item.status, item.isUnresolved])).toEqual([
      ["confirmed", false],
      ["observed", false],
      ["proposed", false],
      ["unknown", true],
      ["conflict", true],
      ["extracted", true],
    ]);
    expect(document.legend.map((entry) => entry.tag)).toEqual(
      statuses.map((status) => `[${status}]`),
    );
  });

  it("includes suggestions and shows an unknown as an open item with its note and no text", () => {
    const { session, record, apply, messageId } = setup();
    const suggested = record(session, "controls", "Audit monthly.", "proposed").session;
    const withUnknown = apply(suggested, {
      kind: "markUnknown",
      createdByType: "agent",
      field: "governance",
      claimId: null,
      note: "Who may change the SOP.",
      sourceMessageId: messageId,
    }).session;
    const document = buildSopDocument(withUnknown);

    expect(sectionOf(document, "controls").items[0]).toMatchObject({
      text: "Audit monthly.",
      provenanceTag: "[proposed]",
      sourceType: "agent_suggestion",
      isUnresolved: false,
    });
    expect(sectionOf(document, "governance")).toMatchObject({
      gapNotice: "Part of this section is still open.",
      items: [
        {
          text: null,
          note: "Who may change the SOP.",
          provenanceTag: "[unknown]",
          isUnresolved: true,
        },
      ],
    });
    expect(document.legend.map((entry) => entry.tag)).toEqual(["[proposed]", "[unknown]"]);
  });

  it("leaves out a withdrawn claim and the history", () => {
    const { session, record, apply, messageId } = setup();
    const claim = record(session, "scope", "Online orders.");
    const withdrawn = apply(claim.session, {
      kind: "withdraw",
      createdByType: "agent",
      claimId: claim.claim.claimId,
      note: "Not in scope.",
      sourceMessageId: messageId,
    }).session;
    const document = buildSopDocument(withdrawn);
    expect(sectionOf(document, "scope").items).toEqual([]);
    expect(JSON.stringify(document)).not.toContain("Online orders.");
    expect(document.counts.totalClaims).toBe(0);
  });

  it("counts confirmed claims, and matches the gap counts", () => {
    const { session, handBuilt } = setup();
    const claims = [
      handBuilt("confirmed", { field: "purpose", claimId: "a" }),
      handBuilt("observed", { field: "scope", claimId: "b" }),
    ];
    expect(buildSopDocument({ ...session, claims }).counts).toEqual({
      blockingGaps: 6,
      advisoryGaps: 5,
      confirmedClaims: 1,
      totalClaims: 2,
    });
  });

  it("carries the approval, and shows which advisory gaps the approver acknowledged", () => {
    const { context, session, record } = setup();
    let current = session;
    for (const field of SOP_FIELD_NAMES.slice(0, 8))
      current = record(current, field, `About ${field}.`).session;
    for (const field of [
      "exceptions",
      "evidence",
      "controls",
      "decisionRules",
      "prerequisites",
    ] as const) {
      const result = setAdvisoryAcknowledgement(current, { field, acknowledged: true }, context);
      if (!result.ok) throw new Error("setup failed");
      current = result.session;
    }
    const approved = approveSession(current, context);
    if (!approved.ok) throw new Error("setup failed");

    const document = buildSopDocument(approved.session);
    expect(document).toMatchObject({ status: "approved", approvedAt: "2026-01-01T00:00:00.000Z" });
    expect(sectionOf(document, "exceptions")).toMatchObject({ isGapAcknowledged: true });
    expect(sectionOf(document, "purpose")).toMatchObject({ isGapAcknowledged: false });
  });

  describe("source line", () => {
    const lineOf = (claims: Claim[], field: SopFieldName) => {
      const { session } = setup();
      return sectionOf(buildSopDocument({ ...session, claims }), field).items.map(
        (item) => item.sourceLine,
      );
    };
    const suggestion = (overrides: Partial<Claim>): Claim =>
      buildClaim({
        claimId: "s",
        field: "controls",
        status: "proposed",
        authority: "proposed",
        source: {
          type: "agent_suggestion",
          reference: { kind: "message", messageId: "message-1" },
        },
        ...overrides,
      });

    it("says where a statement came from, then its date, then its note", () => {
      const plain = buildClaim({ claimId: "a", field: "controls" });
      const dated = buildClaim({ claimId: "b", field: "controls", effectiveDate: "2026-01-01" });
      const noted = buildClaim({
        claimId: "c",
        field: "controls",
        effectiveDate: "2026-01-01",
        note: "Per the 2026 policy.",
      });
      expect(lineOf([plain, dated, noted], "controls")).toEqual([
        "from the interview",
        "from the interview, effective 2026-01-01",
        "from the interview, effective 2026-01-01, Per the 2026 policy.",
      ]);
    });

    it("uses a suggestion's note instead of repeating who suggested it", () => {
      const withNote = suggestion({ note: "Suggested by the interviewer at the user's request." });
      const withoutNote = suggestion({ claimId: "t" });
      const datedWithNote = suggestion({
        claimId: "u",
        note: "Suggested at the user's request.",
        effectiveDate: "2026-02-01",
      });
      expect(lineOf([withNote, withoutNote, datedWithNote], "controls")).toEqual([
        "Suggested by the interviewer at the user's request.",
        "suggested by the assistant",
        "Suggested at the user's request., effective 2026-02-01",
      ]);
      expect(lineOf([withNote], "controls")[0]).not.toContain("suggested by the assistant");
    });

    it("does not repeat an unknown item's note, which is its open-item text", () => {
      const unknown = buildClaim({
        claimId: "k",
        field: "controls",
        status: "unknown",
        note: "Who checks the order.",
      });
      expect(lineOf([unknown], "controls")).toEqual(["from the interview"]);
    });
  });

  it("labels a gap for the preview and the PDF: blocking, advisory, or acknowledged", () => {
    const { context, session, record } = setup();
    const empty = buildSopDocument(session);
    expect(sectionOf(empty, "purpose").gapLabel).toBe("blocking gap");
    expect(sectionOf(empty, "exceptions").gapLabel).toBe("advisory gap");

    const withPurpose = record(session, "purpose", "Handle refunds.").session;
    expect(sectionOf(buildSopDocument(withPurpose), "purpose").gapLabel).toBeNull();

    const acknowledged = setAdvisoryAcknowledgement(
      withPurpose,
      { field: "exceptions", acknowledged: true },
      context,
    );
    if (!acknowledged.ok) throw new Error("setup failed");
    expect(sectionOf(buildSopDocument(acknowledged.session), "exceptions").gapLabel).toBe(
      "gap acknowledged",
    );
  });

  it("is pure: the same session gives the same document, and the input is untouched", () => {
    const { session, record } = setup();
    const frozen = deepFreeze(
      JSON.parse(
        JSON.stringify(record(session, "purpose", "Handle refunds.").session),
      ) as SopSession,
    );
    expect(buildSopDocument(frozen)).toEqual(buildSopDocument(frozen));
  });
});
