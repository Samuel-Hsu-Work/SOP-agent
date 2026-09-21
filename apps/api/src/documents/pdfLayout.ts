/**
 * Rebuilds the reading order of one PDF page from where each piece of text sits. Concatenating
 * pieces in the order the file lists them interleaves the columns of a two-column page, which
 * splits a sentence with unrelated text, and a citation must be a contiguous string from the
 * document. A page with columns is read one column after the other; a table is read row by row.
 */

export interface PositionedText {
  text: string;
  x: number;
  y: number;
  width: number;
  /** The font height. Used to tell a gap between words from a gap between columns. */
  height: number;
}

interface Segment {
  text: string;
  startX: number;
  endX: number;
}

interface Line {
  y: number;
  segments: Segment[];
}

/** A gap wider than this many font heights is a column or a cell, not a space between words. */
const COLUMN_GAP_IN_HEIGHTS = 3;
/** A gap wider than this many font heights, but narrower than a column, is a space. */
const SPACE_GAP_IN_HEIGHTS = 0.2;
/** Left cells shorter than this on average mean a table, not running text in columns. */
const MIN_COLUMN_TEXT_LENGTH = 25;
/** Share of the multi-part lines whose second part must start near the same x for it to be a gutter. */
const GUTTER_AGREEMENT = 0.6;
const GUTTER_TOLERANCE_IN_HEIGHTS = 1.5;

function medianOf(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function groupIntoLines(items: PositionedText[]): Line[] {
  const meaningful = items.filter((item) => item.text.trim().length > 0);
  const sorted = [...meaningful].sort((first, second) => second.y - first.y || first.x - second.x);

  const rows: PositionedText[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const rowY = row?.[0]?.y;
    const tolerance = Math.max(2, item.height * 0.5);
    if (row !== undefined && rowY !== undefined && Math.abs(rowY - item.y) <= tolerance) {
      row.push(item);
    } else {
      rows.push([item]);
    }
  }

  return rows.map((row): Line => {
    const ordered = [...row].sort((first, second) => first.x - second.x);
    const segments: Segment[] = [];
    let previous: PositionedText | undefined;
    for (const item of ordered) {
      const current = segments[segments.length - 1];
      if (previous === undefined || current === undefined) {
        segments.push({ text: item.text, startX: item.x, endX: item.x + item.width });
      } else {
        const gap = item.x - (previous.x + previous.width);
        const height = Math.max(item.height, previous.height, 1);
        if (gap > height * COLUMN_GAP_IN_HEIGHTS) {
          segments.push({ text: item.text, startX: item.x, endX: item.x + item.width });
        } else {
          const needsSpace =
            gap > height * SPACE_GAP_IN_HEIGHTS &&
            !/\s$/.test(current.text) &&
            !/^\s/.test(item.text);
          current.text += (needsSpace ? " " : "") + item.text;
          current.endX = item.x + item.width;
        }
      }
      previous = item;
    }
    return { y: row[0]?.y ?? 0, segments };
  });
}

/** The x where the right column starts, or null when the page does not read as columns. */
function findGutter(lines: Line[], typicalHeight: number): number | null {
  const multi = lines.filter((line) => line.segments.length >= 2);
  if (multi.length < 3 || multi.length < lines.length * 0.3) return null;

  const secondStarts = multi.map((line) => line.segments[1]?.startX ?? 0);
  const gutter = medianOf(secondStarts);
  const tolerance = typicalHeight * GUTTER_TOLERANCE_IN_HEIGHTS;
  const agreeing = secondStarts.filter((start) => Math.abs(start - gutter) <= tolerance).length;
  if (agreeing / multi.length < GUTTER_AGREEMENT) return null;

  const leftLengths = multi.map((line) => line.segments[0]?.text.length ?? 0);
  const averageLeft = leftLengths.reduce((sum, length) => sum + length, 0) / leftLengths.length;
  return averageLeft >= MIN_COLUMN_TEXT_LENGTH ? gutter : null;
}

export function layoutPageText(items: PositionedText[]): string {
  const lines = groupIntoLines(items);
  if (lines.length === 0) return "";

  const typicalHeight =
    medianOf(items.map((item) => item.height).filter((height) => height > 0)) || 10;
  const gutter = findGutter(lines, typicalHeight);
  if (gutter === null) {
    // Plain text, or a table: one line per row, cells kept apart.
    return lines.map((line) => line.segments.map((segment) => segment.text).join(" | ")).join("\n");
  }

  // Columns. Lines that span the gutter (a title) end one block and start the next; inside a
  // block the left column is read, then the right.
  const tolerance = typicalHeight * GUTTER_TOLERANCE_IN_HEIGHTS;
  const output: string[] = [];
  let left: string[] = [];
  let right: string[] = [];
  const flush = () => {
    output.push(...left, ...right);
    left = [];
    right = [];
  };
  for (const line of lines) {
    const first = line.segments[0];
    if (first === undefined) continue;
    const spansGutter =
      line.segments.length === 1 &&
      first.startX < gutter - tolerance &&
      first.endX > gutter + tolerance;
    if (spansGutter) {
      flush();
      output.push(first.text);
      continue;
    }
    for (const segment of line.segments) {
      (segment.startX >= gutter - tolerance ? right : left).push(segment.text);
    }
  }
  flush();
  return output.join("\n");
}
