import { describe, expect, it } from "vitest";
import { sessionIdForLog } from "./logging.ts";

describe("sessionIdForLog", () => {
  it("passes a UUID through, so a session's turns can be correlated", () => {
    const id = "ee16ca96-1d9e-49d7-96c3-e5c212e6d138";
    expect(sessionIdForLog(id)).toBe(id);
  });

  it("returns null for anything else, since a tampered id could carry text", () => {
    expect(sessionIdForLog("Refund policy for the Acme account")).toBeNull();
    expect(sessionIdForLog("id-1")).toBeNull();
    expect(sessionIdForLog("ee16ca96-1d9e-49d7-96c3-e5c212e6d138 extra")).toBeNull();
    expect(sessionIdForLog("")).toBeNull();
  });
});
