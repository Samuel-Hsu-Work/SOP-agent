/*
 * Small text helpers shared by the rules that compare statements: duplicate detection, the interview
 * agenda's "did the user state a number" check, and conflict detection.
 */

/** Case and whitespace do not make a statement new: "Send it" and " send  it " are the same statement. */
export function normalizeStatement(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

const SPELLED_NUMBERS = [
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "fifteen",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "dozen",
];
const QUANTITY_PATTERN = new RegExp(
  `\\d[\\d,]*(?:\\.\\d+)?|\\b(?:${SPELLED_NUMBERS.join("|")})\\b`,
  "gi",
);

/** The numbers in a text, written the same way whether the text says "$1,000" or "1000". */
export function quantitiesIn(text: string): Set<string> {
  return new Set(
    [...text.matchAll(QUANTITY_PATTERN)].map((match) => match[0].toLowerCase().replace(/,/g, "")),
  );
}

/** Words that say nothing about what a statement is about. Comparison words are here too: "above" is not a topic. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "were",
  "been",
  "with",
  "from",
  "that",
  "this",
  "must",
  "may",
  "will",
  "shall",
  "should",
  "any",
  "all",
  "every",
  "each",
  "only",
  "than",
  "then",
  "not",
  "per",
  "their",
  "they",
  "its",
  "has",
  "have",
  "into",
  "over",
  "above",
  "below",
  "under",
  "within",
  "still",
  "both",
  "also",
  "when",
  "who",
  "which",
]);

/**
 * The words a statement is about: lower case, no numbers, no filler, a trailing plural "s" removed
 * so "payment" and "payments" match. Two statements about the same thing share most of these.
 */
export function significantWordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    words.add(
      token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token,
    );
  }
  return words;
}
