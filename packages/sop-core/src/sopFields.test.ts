import { describe, expect, it } from "vitest";
import { ADVISORY_FIELD_NAMES, getFieldClass, SOP_FIELD_NAMES, SOP_FIELDS } from "./sopFields.ts";

const BLOCKING_FIELDS = [
  "purpose",
  "scope",
  "trigger",
  "roles",
  "procedure",
  "authorization",
  "completionCriteria",
  "governance",
];
const ADVISORY_FIELDS = ["exceptions", "evidence", "controls", "decisionRules", "prerequisites"];

describe("SOP fields", () => {
  it("are exactly the 13 agreed fields, blocking first", () => {
    expect([...SOP_FIELD_NAMES]).toEqual([...BLOCKING_FIELDS, ...ADVISORY_FIELDS]);
  });

  it("split into eight blocking fields and five advisory fields", () => {
    const blocking = SOP_FIELDS.filter((field) => field.fieldClass === "blocking");
    const advisory = SOP_FIELDS.filter((field) => field.fieldClass === "advisory");
    expect(blocking.map((field) => field.name)).toEqual(BLOCKING_FIELDS);
    expect(advisory.map((field) => field.name)).toEqual(ADVISORY_FIELDS);
  });

  it("keep exceptions advisory", () => {
    expect(getFieldClass("exceptions")).toBe("advisory");
  });

  it("have a label and a description each, in the same order as the names", () => {
    expect(SOP_FIELDS.map((field) => field.name)).toEqual([...SOP_FIELD_NAMES]);
    for (const field of SOP_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.description.length).toBeGreaterThan(0);
    }
  });

  it("lists the advisory fields for acknowledgement in the same order as the field list", () => {
    expect([...ADVISORY_FIELD_NAMES]).toEqual(ADVISORY_FIELDS);
    for (const field of ADVISORY_FIELD_NAMES) expect(getFieldClass(field)).toBe("advisory");
  });
});
