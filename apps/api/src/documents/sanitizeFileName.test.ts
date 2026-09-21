import { describe, expect, it } from "vitest";
import { sanitizeFileName } from "./sanitizeFileName.ts";

describe("sanitizeFileName", () => {
  it("keeps an ordinary name as it is", () => {
    expect(sanitizeFileName("Vendor Payment Policy v2.pdf")).toBe("Vendor Payment Policy v2.pdf");
  });

  it("drops any path, from either kind of separator", () => {
    expect(sanitizeFileName("../../etc/passwd.md")).toBe("passwd.md");
    expect(sanitizeFileName("C:\\Users\\me\\policy.docx")).toBe("policy.docx");
  });

  it("replaces control, zero-width and direction-changing characters with a space", () => {
    expect(sanitizeFileName(`a${String.fromCharCode(0)}b${String.fromCharCode(0x202e)}c.md`)).toBe(
      "a b c.md",
    );
    expect(sanitizeFileName(`line${String.fromCharCode(10)}break.md`)).toBe("line break.md");
  });

  it("falls back to a fixed name when nothing usable is left", () => {
    expect(sanitizeFileName("")).toBe("Uploaded document");
    expect(sanitizeFileName("..")).toBe("Uploaded document");
    expect(sanitizeFileName(`${String.fromCharCode(0)}${String.fromCharCode(0x202e)}`)).toBe(
      "Uploaded document",
    );
  });

  it("cuts a long name but keeps its extension", () => {
    const name = sanitizeFileName(`${"a".repeat(500)}.docx`);
    expect(name.length).toBe(200);
    expect(name.endsWith(".docx")).toBe(true);
  });
});
