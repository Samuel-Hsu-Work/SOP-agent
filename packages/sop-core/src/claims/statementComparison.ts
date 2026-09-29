import { normalizeStatement, quantitiesIn, significantWordsOf } from "../text.ts";

/*
 * Comparing statements, deterministically: whether two say the same thing, disagree about one
 * thing, or one keeps what gives the other its meaning, and whether a text uses a passage's wording.
 * Pure functions over text, so conflict detection, the passage rules and the eval assertions judge
 * a statement the same way; nothing here reads or writes a session.
 */

/**
 * How much of the shorter statement's words the other one also uses before the two count as being
 * about the same thing. Half is deliberately generous: missing a conflict lets a document silently
 * disagree with the SOP, while flagging a paraphrase costs one answer in chat.
 */
export const CONFLICT_TOPIC_OVERLAP = 0.5;

/** With different numbers, two statements need only this many words in common to be about one thing. */
const SHARED_WORDS_WHEN_NUMBERS_DIFFER = 1;

function sharedCount(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
  let shared = 0;
  for (const word of first) if (second.has(word)) shared += 1;
  return shared;
}

function haveSameFigures(first: string, second: string): boolean {
  const firstQuantities = quantitiesIn(first);
  const secondQuantities = quantitiesIn(second);
  return (
    firstQuantities.size === secondQuantities.size &&
    [...firstQuantities].every((quantity) => secondQuantities.has(quantity))
  );
}

/**
 * Words that turn a statement into its opposite. Two statements are only the same when they agree
 * on these exactly: "refunds need approval" is not "refunds do not need approval".
 */
const NEGATION_WORDS: ReadonlySet<string> = new Set(["not", "no", "never", "without", "except"]);

/**
 * The words that set a boundary or a direction: "over" against "under", "up to" against "above".
 * The topic comparison leaves them out on purpose ("above" is not a topic), so a statement counts
 * as already said only when the other one uses every one of its boundary words too.
 */
const QUALIFIER_WORDS: ReadonlySet<string> = new Set([
  "only",
  "over",
  "under",
  "above",
  "below",
  "within",
  "before",
  "after",
  "until",
  "less",
  "more",
  "fewer",
  "least",
  "most",
  "exceed",
  "exceeds",
  "up",
]);

function wordsFrom(text: string, vocabulary: ReadonlySet<string>): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => vocabulary.has(word)),
  );
}

/** Negation words that say the same thing: "no cashier may", "cashiers may not", "never", "can't". */
const PLAIN_NEGATIONS: ReadonlySet<string> = new Set(["not", "no", "never"]);

/**
 * The negations a text uses. "no", "never", "cannot" and "can't" all count as "not": they are the
 * same plain negation said differently. "without" and "except" stay apart, since they limit a rule
 * rather than negate it.
 */
function negationsIn(text: string): Set<string> {
  const negations = new Set(
    [...wordsFrom(text, NEGATION_WORDS)].map((word) => (PLAIN_NEGATIONS.has(word) ? "not" : word)),
  );
  if (/\bcannot\b|n['’]t\b/i.test(text)) negations.add("not");
  return negations;
}

function isSameSet(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every((word) => second.has(word));
}

/** Words that state how often: a figure written as a word. "Reconcile daily" is not "reconcile weekly". */
const FREQUENCY_WORDS: ReadonlySet<string> = new Set([
  "hourly",
  "daily",
  "nightly",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "yearly",
  "annually",
  "once",
  "twice",
  "half",
]);

function figuresIn(text: string): Set<string> {
  return new Set([...quantitiesIn(text), ...wordsFrom(text, FREQUENCY_WORDS)]);
}

/**
 * Whether `statement` keeps what gives `passageStatement` its meaning, beyond its topic: exactly the
 * same figures and frequencies, every boundary word it uses, and the same negation. A statement may
 * reword the passage and add detail, but no figure of its own: "over $10,000 rather than $25,000"
 * still names the passage's figure while replacing it. It guards a statement resting on a passage
 * the person never checked it against (they stated it first, or said a conflict's two sides mean
 * the same), where the agent's reading alone would otherwise decide: word overlap says "may extend a
 * shift" and "may not extend a shift" are about the same thing, which they are, and nothing more. A
 * refusal only costs the old path, a conflict the person settles. A different approver or actor is
 * not caught; that stays the agent's reading.
 */
export function keepsPassageMeaning(statement: string, passageStatement: string): boolean {
  if (!isSameSet(figuresIn(statement), figuresIn(passageStatement))) return false;
  if (!isSameSet(negationsIn(statement), negationsIn(passageStatement))) return false;
  const qualifiers = wordsFrom(statement, QUALIFIER_WORDS);
  return [...wordsFrom(passageStatement, QUALIFIER_WORDS)].every((word) => qualifiers.has(word));
}

/**
 * Does `claimText` already say what `statement` says? The same words, or every word that matters in
 * `statement`, every figure and every boundary word, and the same negation: "over $100" and "under
 * $100" share their topic and figure but not their meaning. The claim may say more ("clock out by
 * 11:30 after closing duties" already says "clock out by 11:30"). A passage the SOP already states
 * is neither new material nor a disagreement.
 */
export function statesTheSameThing(statement: string, claimText: string): boolean {
  if (normalizeStatement(statement) === normalizeStatement(claimText)) return true;
  if (!haveSameFigures(statement, claimText)) return false;
  if (!isSameSet(negationsIn(statement), negationsIn(claimText))) return false;
  const claimQualifiers = wordsFrom(claimText, QUALIFIER_WORDS);
  if ([...wordsFrom(statement, QUALIFIER_WORDS)].some((word) => !claimQualifiers.has(word))) {
    return false;
  }
  const words = significantWordsOf(statement);
  const claimWords = significantWordsOf(claimText);
  return words.size > 0 && [...words].every((word) => claimWords.has(word));
}

/**
 * Do these two statements disagree about the same thing? Deterministic on purpose: a model judging
 * this would let a document influence whether a conflict is raised at all.
 *
 * - Both state numbers and they differ, and the two share at least one word: a conflict. This is
 *   the case that matters, "above $10,000" against "up to $25,000".
 * - Only one states numbers: not a conflict. One is more specific than the other ("label each sample
 *   after collection" against "label each sample within 30 minutes"), which is detail for the agent to put to the
 *   person as a passage, not two answers to choose between.
 * - Otherwise they conflict when at least half of the shorter one's words appear in the other.
 *   That includes two statements with the same figures: the same $10,000 approved by the CFO in one
 *   and by a manager in the other still disagree, and the rule cannot tell who from the words, so
 *   it flags a restatement too rather than let a contradiction through.
 */
export function disagreeAboutTheSameThing(firstText: string, secondText: string): boolean {
  if (statesTheSameThing(firstText, secondText) || statesTheSameThing(secondText, firstText)) {
    return false;
  }
  const firstWords = significantWordsOf(firstText);
  const secondWords = significantWordsOf(secondText);
  const shared = sharedCount(firstWords, secondWords);

  const firstHasFigures = quantitiesIn(firstText).size > 0;
  const secondHasFigures = quantitiesIn(secondText).size > 0;
  if (firstHasFigures !== secondHasFigures) return false;
  if (firstHasFigures && !haveSameFigures(firstText, secondText)) {
    return shared >= SHARED_WORDS_WHEN_NUMBERS_DIFFER;
  }

  const shorter = Math.min(firstWords.size, secondWords.size);
  return shorter > 0 && shared / shorter >= CONFLICT_TOPIC_OVERLAP;
}

/**
 * How much of a passage's words, and figures, a text must use to be about that passage: a reply
 * that puts it to the person, or a user's message that states it first. Both reword it, so this is
 * lower than the conflict rule's overlap; a question that only shares the field's topic uses far
 * fewer of them.
 */
export const PASSAGE_WORDING_OVERLAP = 0.4;

function wordsAndFiguresOf(text: string): Set<string> {
  return new Set([...significantWordsOf(text), ...quantitiesIn(text)]);
}

/**
 * Whether a text uses enough of a passage's wording to be about it. Deterministic, and judged on the
 * text itself: a passage handed to the agent is not asked just because it was handed over, and a
 * passage is not what the user said just because the agent says so.
 */
export function usesPassageWording(text: string, statement: string): boolean {
  const passageWords = wordsAndFiguresOf(statement);
  if (passageWords.size === 0) return false;
  const textWords = wordsAndFiguresOf(text);
  let shared = 0;
  for (const word of passageWords) if (textWords.has(word)) shared += 1;
  return shared / passageWords.size >= PASSAGE_WORDING_OVERLAP;
}
