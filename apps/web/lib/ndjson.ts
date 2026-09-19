/**
 * Splits a stream of text chunks into complete lines. A chunk can end in the middle of a line, so
 * the unfinished tail is held back until the next chunk completes it.
 */
export class NdjsonLineSplitter {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }

  /** Returns whatever is left when the stream ends. */
  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = "";
    return rest.length > 0 ? [rest] : [];
  }
}
