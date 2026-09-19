import { describe, expect, it } from "vitest";
import { NdjsonLineSplitter } from "./ndjson.ts";

describe("NdjsonLineSplitter", () => {
  it("returns complete lines and holds back the unfinished tail", () => {
    const splitter = new NdjsonLineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n{"c":3}\n')).toEqual(['{"b":2}', '{"c":3}']);
    expect(splitter.flush()).toEqual([]);
  });

  it("gives the same lines however the text is cut into chunks", () => {
    const text = '{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n';
    for (let size = 1; size <= text.length; size += 1) {
      const splitter = new NdjsonLineSplitter();
      const lines: string[] = [];
      for (let index = 0; index < text.length; index += size) {
        lines.push(...splitter.push(text.slice(index, index + size)));
      }
      lines.push(...splitter.flush());
      expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}', '{"type":"c"}']);
    }
  });

  it("ignores blank lines and returns a final line that has no newline", () => {
    const splitter = new NdjsonLineSplitter();
    expect(splitter.push('\n\n{"a":1}')).toEqual([]);
    expect(splitter.flush()).toEqual(['{"a":1}']);
  });
});
