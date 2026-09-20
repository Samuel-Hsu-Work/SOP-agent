/**
 * The PDF uses the standard Helvetica fonts, which draw only the WinAnsi characters. pdfkit gives
 * no signal for anything else: it silently prints the wrong glyphs, and a wrong word in the only
 * durable record of an approved SOP is worse than an ugly one. So every string goes through here
 * first, and each character the font cannot draw becomes a visible `<U+XXXX>` marker that keeps
 * which character it was.
 */

/**
 * The Windows-1252 characters that sit in the 0x80-0x9F range, as Unicode code points: euro, low
 * quotes, ellipsis, dagger, the curly quotes, bullet, en and em dash, trademark, and the accented
 * letters Š š Œ œ Ž ž Ÿ. The rest of WinAnsi is ASCII and Latin-1.
 */
const WINDOWS_1252_EXTRA_CODE_POINTS: ReadonlySet<number> = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/** Invisible characters that draw nothing, so there is nothing to mark. */
const INVISIBLE_FORMAT_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff,
]);

export interface PrintableText {
  text: string;
  /** How many characters were replaced with a marker. A count only, never the characters. */
  replacedCharacters: number;
}

function isDrawable(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return WINDOWS_1252_EXTRA_CODE_POINTS.has(codePoint);
}

function formatCodePointMarker(codePoint: number): string {
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
}

/**
 * Line breaks are kept (CRLF, CR, and the Unicode line and paragraph separators become one
 * newline), a tab becomes a space, and other control characters and invisible format characters
 * are dropped. The walk is by code point, so an emoji is one marker, not two half-characters.
 */
export function toPrintableText(input: string): PrintableText {
  let text = "";
  let replacedCharacters = 0;

  const characters = Array.from(input);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] as string;
    const codePoint = character.codePointAt(0) as number;

    if (codePoint === 0x0d) {
      if (characters[index + 1] === "\n") index += 1;
      text += "\n";
    } else if (codePoint === 0x0a || codePoint === 0x2028 || codePoint === 0x2029) {
      text += "\n";
    } else if (codePoint === 0x09) {
      text += " ";
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      // A control character: nothing to draw.
    } else if (INVISIBLE_FORMAT_CODE_POINTS.has(codePoint)) {
      // Draws nothing.
    } else if (isDrawable(codePoint)) {
      text += character;
    } else {
      text += formatCodePointMarker(codePoint);
      replacedCharacters += 1;
    }
  }
  return { text, replacedCharacters };
}
