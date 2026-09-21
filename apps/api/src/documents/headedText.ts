import { MAX_SECTION_CHARACTERS } from "./documentLimits.ts";

/** One line of text, and the heading it is when it is one. Passing the mark along, not a "# " prefix, keeps a paragraph that starts with a hash sign from being read as a heading. */
export interface MarkedLine {
  heading: string | null;
  line: string;
}

/** A slice of a document that a claim can cite. `location` is what a person sees; code sets it. */
export interface TextSection {
  location: string;
  text: string;
}

/** The longest heading text kept in a location, so a location stays short. */
const MAX_HEADING_IN_LOCATION = 100;

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

/**
 * Markdown lines with their headings marked, so the same splitter serves Markdown and DOCX.
 * A heading inside a fenced code block is code, not a heading; a line followed by `===` or `---`
 * is a heading too (setext); a `---` after a blank line is only a rule.
 */
function markHeadingsInMarkdown(text: string): MarkedLine[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const marked: MarkedLine[] = [];
  let fence: string | null = null;

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] ?? "";
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] as string;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      marked.push({ heading: null, line });
      continue;
    }
    if (fence !== null) {
      marked.push({ heading: null, line });
      continue;
    }

    const atx = ATX_HEADING.exec(line);
    if (atx !== null) {
      marked.push({ heading: (atx[1] ?? "").trim(), line });
      continue;
    }

    const next = rawLines[index + 1];
    if (line.trim() !== "" && next !== undefined && SETEXT_UNDERLINE.test(next)) {
      marked.push({ heading: line.trim(), line });
      index += 1; // the underline is part of the heading
      continue;
    }
    marked.push({ heading: null, line });
  }
  return marked;
}

/** Splits marked lines at headings. Each section's text starts with its own heading line. */
function splitAtHeadings(marked: MarkedLine[]): TextSection[] {
  const sections: TextSection[] = [];
  const seen = new Map<string, number>();
  let location = "preamble";
  let lines: string[] = [];

  const close = () => {
    const text = lines.join("\n").trim();
    if (text.length > 0) sections.push({ location, text });
  };

  for (const entry of marked) {
    if (entry.heading !== null && entry.heading !== "") {
      close();
      const heading = entry.heading.slice(0, MAX_HEADING_IN_LOCATION);
      const count = (seen.get(heading) ?? 0) + 1;
      seen.set(heading, count);
      location = count === 1 ? `§ ${heading}` : `§ ${heading} (${count})`;
      lines = [entry.heading];
    } else {
      lines.push(entry.line);
    }
  }
  close();
  return sections;
}

export function splitMarkdownIntoSections(text: string): TextSection[] {
  return splitAtHeadings(markHeadingsInMarkdown(text));
}

/** For DOCX: lines already reduced to plain text, each marked as a heading or not. */
export function splitMarkedLinesIntoSections(lines: MarkedLine[]): TextSection[] {
  return splitAtHeadings(lines);
}

/**
 * A section longer than the limit is split into parts at line breaks, so no one section dominates
 * a prompt. The first part keeps the section's location; later ones are "(part 2)" and so on. A
 * single line longer than the limit is cut by length: nothing is dropped.
 */
export function splitLongSections(sections: TextSection[]): TextSection[] {
  const result: TextSection[] = [];
  for (const section of sections) {
    if (section.text.length <= MAX_SECTION_CHARACTERS) {
      result.push(section);
      continue;
    }
    const parts: string[] = [];
    let current = "";
    const push = (line: string) => {
      if (current.length + line.length + 1 > MAX_SECTION_CHARACTERS && current.length > 0) {
        parts.push(current);
        current = "";
      }
      current += (current.length > 0 ? "\n" : "") + line;
    };
    for (const line of section.text.split("\n")) {
      if (line.length <= MAX_SECTION_CHARACTERS) {
        push(line);
        continue;
      }
      for (let start = 0; start < line.length; start += MAX_SECTION_CHARACTERS) {
        push(line.slice(start, start + MAX_SECTION_CHARACTERS));
      }
    }
    if (current.length > 0) parts.push(current);
    parts.forEach((text, index) => {
      result.push({
        location: index === 0 ? section.location : `${section.location} (part ${index + 1})`,
        text,
      });
    });
  }
  return result;
}
