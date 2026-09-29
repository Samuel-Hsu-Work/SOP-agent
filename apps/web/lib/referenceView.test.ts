import { addReferenceDocument, applyClaim, markDocumentPassagesOffered } from "@sop-agent/sop-core";
import {
  buildReferenceUpload,
  createDeterministicContext,
  createSessionWithTarget,
} from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { buildReferenceView } from "./referenceView.ts";

function setup() {
  const context = createDeterministicContext();
  const session = createSessionWithTarget(context, {
    purpose: ["Describe how a cashier closes out at night."],
    scope: ["Applies to front-end cashiers on the closing shift."],
  });
  const upload = (fileName: string, statements: string[]) => {
    const result = addReferenceDocument(
      session,
      buildReferenceUpload(
        fileName,
        statements.map((statement, index) => ({
          field: "completionCriteria" as const,
          statement,
          location: `p.${index + 1}`,
        })),
      ),
      context,
    );
    if (!result.ok) throw new Error(`setup failed: ${result.error.code}`);
    return result.session;
  };
  return { context, session, upload };
}

describe("buildReferenceView", () => {
  it("lists each document's passages with their field, quote, location and where they stand", () => {
    const { upload } = setup();
    const session = upload("store-policy.pdf", [
      "Cashiers clock out by 11:30 PM.",
      "The shift log is signed before leaving.",
    ]);
    const firstId = session.references.passages[0]?.passageId ?? "";
    const view = buildReferenceView(markDocumentPassagesOffered(session, [firstId]));

    expect(view).toHaveLength(1);
    expect(view[0]?.documentName).toBe("store-policy.pdf");
    expect(view[0]?.notYetAnsweredCount).toBe(2);
    expect(view[0]?.passages).toMatchObject([
      {
        fieldLabel: "Completion criteria",
        statement: "Cashiers clock out by 11:30 PM.",
        citation: { location: "p.1", quote: "Cashiers clock out by 11:30 PM." },
        stateLabel: "Asked about in chat",
        isStale: false,
      },
      { statement: "The shift log is signed before leaving.", stateLabel: "Not discussed yet" },
    ]);
  });

  it("says a passage no longer applies once the scope it was read for is removed", () => {
    const { upload, context } = setup();
    const session = upload("store-policy.pdf", ["Cashiers clock out by 11:30 PM."]);
    const scope = session.claims.find((claim) => claim.field === "scope");
    const withdrawn = applyClaim(
      session,
      {
        kind: "withdraw",
        createdByType: "agent",
        claimId: scope?.claimId ?? "",
        note: "Wrong process.",
        sourceMessageId: session.messages[0]?.id ?? "",
      },
      context,
    );
    if (!withdrawn.ok) throw new Error("setup failed");
    const [document] = buildReferenceView(withdrawn.session);
    expect(document?.passages[0]).toMatchObject({
      isStale: true,
      stateLabel: "Read for an earlier scope: upload again to check it",
    });
    // A stale passage is never put to the user again, so it is not waiting for an answer.
    expect(document?.notYetAnsweredCount).toBe(0);
  });
});
