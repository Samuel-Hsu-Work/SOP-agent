import { MAX_UPLOAD_BYTES } from "@sop-agent/sop-core";
import { describe, expect, it } from "vitest";
import { checkFileBeforeUpload, requestDocumentExtraction } from "./extractDocument.ts";

const file = new File(["# Rules\nPayments need approval."], "policy.md", { type: "text/markdown" });

const successBody = {
  document: { fileName: "policy.md", fileKind: "markdown", sectionCount: 1, characterCount: 30 },
  claims: [
    {
      field: "authorization",
      statement: "Payments need approval.",
      effectiveDate: null,
      citation: {
        documentName: "policy.md",
        location: "§ Rules",
        quote: "Payments need approval.",
      },
    },
  ],
  rejected: { count: 0, reasons: {} },
  truncatedCount: 0,
};

function run(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const result = requestDocumentExtraction({
    apiBaseUrl: "http://api.test",
    file,
    fetchImplementation: async (url, init) => {
      calls.push({ url: String(url), init });
      return respond();
    },
  });
  return { result, calls };
}

describe("requestDocumentExtraction", () => {
  it("sends the file alone as a multipart form and returns the validated drafts", async () => {
    const { result, calls } = run(async () => Response.json(successBody));
    const outcome = await result;

    expect(calls[0]?.url).toBe("http://api.test/documents/extract");
    expect(calls[0]?.init?.method).toBe("POST");
    const form = calls[0]?.init?.body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
    expect((form.get("file") as File).name).toBe("policy.md");
    // No content-type header is set by hand: the browser adds the multipart boundary.
    expect(calls[0]?.init?.headers).toBeUndefined();
    expect(outcome.kind).toBe("received");
    if (outcome.kind === "received") expect(outcome.response.claims).toHaveLength(1);
  });

  it("says the server could not be reached when the network fails", async () => {
    const { result } = run(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await result).toEqual({
      kind: "failed",
      message: "Could not reach the server. Check that the API is running, then try again.",
    });
  });

  it("shows the server's own sentence for a structured refusal", async () => {
    const { result } = run(async () =>
      Response.json(
        { error: { code: "document_has_no_text", message: "That PDF has no text to read." } },
        { status: 422 },
      ),
    );
    expect(await result).toEqual({ kind: "failed", message: "That PDF has no text to read." });
  });

  it("falls back to the status when the error body is not the expected shape", async () => {
    const { result } = run(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await result).toEqual({
      kind: "failed",
      message: "The server answered with an error (502).",
    });
  });

  it("does not use a response that is not what the contract promises", async () => {
    const withStatus = {
      ...successBody,
      claims: [{ ...successBody.claims[0], field: "everything" }],
    };
    const { result } = run(async () => Response.json(withStatus));
    expect(await result).toEqual({
      kind: "failed",
      message: "The server sent a response this app does not understand.",
    });
    const { result: notJson } = run(async () => new Response("nope", { status: 200 }));
    expect((await notJson).kind).toBe("failed");
  });
});

describe("checkFileBeforeUpload", () => {
  it("accepts the four supported types, in any letter case", () => {
    for (const name of ["a.pdf", "a.DOCX", "a.md", "notes.TXT"]) {
      expect(checkFileBeforeUpload({ name, size: 100 })).toBeNull();
    }
  });

  it("refuses an unsupported type, an empty file, and a file over the limit, before sending", () => {
    expect(checkFileBeforeUpload({ name: "photo.png", size: 100 })).toContain("not supported");
    expect(checkFileBeforeUpload({ name: "noextension", size: 100 })).toContain("not supported");
    expect(checkFileBeforeUpload({ name: "a.md", size: 0 })).toBe("That file is empty.");
    expect(checkFileBeforeUpload({ name: "a.md", size: MAX_UPLOAD_BYTES + 1 })).toContain("2 MB");
    expect(checkFileBeforeUpload({ name: "a.md", size: MAX_UPLOAD_BYTES })).toBeNull();
  });
});
