import { createEmptySession, type SopSession } from "@sop-agent/sop-core";
import { createDeterministicContext } from "@sop-agent/sop-core/testing";
import { describe, expect, it } from "vitest";
import { requestSopPdf } from "./downloadSopPdf.ts";

const session: SopSession = {
  ...createEmptySession(createDeterministicContext()),
  status: "approved",
  approvedAt: "2026-01-02T00:00:00.000Z",
};

function pdfResponse(init: ResponseInit = {}): Response {
  return new Response("%PDF-1.4 test", {
    status: 200,
    headers: { "content-type": "application/pdf" },
    ...init,
  });
}

function run(respond: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const result = requestSopPdf({
    apiBaseUrl: "http://api.test",
    session,
    fetchImplementation: async (url, init) => {
      calls.push({ url: String(url), init });
      return respond();
    },
  });
  return { result, calls };
}

describe("requestSopPdf", () => {
  it("posts the session and returns the PDF without touching the session", async () => {
    const { result, calls } = run(async () => pdfResponse());
    const outcome = await result;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://api.test/sops/pdf");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ session });
    expect(outcome.kind).toBe("received");
    if (outcome.kind === "received") {
      expect(outcome.pdf.type).toBe("application/pdf");
      expect(await outcome.pdf.text()).toBe("%PDF-1.4 test");
    }
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

  it("shows the server's own sentence for a structured error", async () => {
    const { result } = run(async () =>
      Response.json(
        { error: { code: "sop_not_approved", message: "This SOP cannot be exported." } },
        { status: 409 },
      ),
    );
    expect(await result).toEqual({ kind: "failed", message: "This SOP cannot be exported." });
  });

  it("falls back to the status when the error body is not the expected shape", async () => {
    const { result } = run(async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await result).toEqual({
      kind: "failed",
      message: "The server answered with an error (502).",
    });
  });

  it("does not accept a success that is not a PDF", async () => {
    const { result } = run(async () => Response.json({ ok: true }));
    expect(await result).toEqual({
      kind: "failed",
      message: "The server sent a response this app does not understand.",
    });
  });
});
