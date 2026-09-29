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
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
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
  "billion",
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

/**
 * The numbers a statement states, for the provenance check. "one" counts here, unlike in
 * `quantitiesIn` (where "no one" and "one of them" would make every sentence look numeric): a
 * statement that says "one manager" when its source does not has added a figure.
 */
function statedNumbersIn(text: string): Set<string> {
  const numbers = quantitiesIn(text);
  if (/\bone\b/i.test(text)) numbers.add("one");
  return numbers;
}

/**
 * Whether every number in `statement` also appears in one of `sources`. A statement written from a
 * document passage may reword it, but a figure it states must come from the passage's quote or from
 * what the user said, never from the writer. A figure written differently ("2" for "two") is refused
 * too: the check errs toward refusing a statement, not toward letting a figure through.
 */
export function areNumbersSupported(statement: string, sources: readonly string[]): boolean {
  const available = new Set(sources.flatMap((source) => [...statedNumbersIn(source)]));
  return [...statedNumbersIn(statement)].every((quantity) => available.has(quantity));
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
