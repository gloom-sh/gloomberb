interface FuzzyMatchResult {
  match: boolean;
  score: number;
}

const NO_MATCH: FuzzyMatchResult = { match: false, score: 0 };

/** Awarded on top of the per-word scores when the words also appear as one phrase. */
const PHRASE_BONUS = 1000;

function isWordStart(text: string, index: number): boolean {
  return index === 0 || !/[a-z0-9]/i.test(text[index - 1]!);
}

/**
 * Subsequence fallback, kept deliberately narrow: the first query character
 * must be the first character of the text, and every one after it must start
 * a word or directly follow the previous match, so the query has to read as
 * an ordered run of word prefixes from the start ("cm" or "corrmat" for
 * "Correlation Matrix"). Letters scattered across the text, which is how
 * "nvidia" used to hit "Options Calculator" through its keywords, no longer
 * count, and callers that hand over a keyword-heavy haystack instead of a
 * label still get a run that begins in the label.
 */
function matchWordPrefixRun(query: string, label: string): FuzzyMatchResult {
  if (label[0] !== query[0]) return NO_MATCH;
  let qi = 1;
  let score = 10;
  let previous = 0;
  for (let li = 1; li < label.length && qi < query.length; li++) {
    if (label[li] !== query[qi]) continue;
    const atWordStart = isWordStart(label, li);
    if (!atWordStart && li !== previous + 1) continue;
    score += atWordStart ? 10 : 1;
    previous = li;
    qi++;
  }
  return qi === query.length ? { match: true, score } : NO_MATCH;
}

/**
 * Match one lowercase word. Exact, token, prefix, and substring hits are looked
 * up in the full haystack; the looser fallback only ever sees the label, since
 * keywords and descriptions are there to be found by whole words, not letters.
 */
function matchTerm(term: string, haystack: string, label: string): FuzzyMatchResult {
  if (haystack === term) return { match: true, score: 2500 - term.length };

  const tokens = haystack.split(/\s+/).filter(Boolean);
  const exactTokenIndex = tokens.findIndex((token) => token === term);
  if (exactTokenIndex >= 0) return { match: true, score: 2200 - term.length - exactTokenIndex };

  const prefixTokenIndex = tokens.findIndex((token) => token.startsWith(term));
  if (prefixTokenIndex >= 0) {
    const token = tokens[prefixTokenIndex]!;
    return { match: true, score: 1000 - term.length - prefixTokenIndex - (token.length - term.length) };
  }

  if (haystack.includes(term)) return { match: true, score: 500 - term.length };

  return matchWordPrefixRun(term, label);
}

/** Every word of the query has to match on its own; the whole phrase matching too ranks higher. */
function fuzzyMatch(query: string, target: string, label: string): FuzzyMatchResult {
  const q = query.toLowerCase().trim();
  const haystack = target.toLowerCase();
  const labelText = label.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);

  if (terms.length === 0) return { match: true, score: 0 };
  if (terms.length === 1) return matchTerm(terms[0]!, haystack, labelText);

  let score = 0;
  for (const term of terms) {
    const result = matchTerm(term, haystack, labelText);
    if (!result.match) return NO_MATCH;
    score += result.score;
  }
  if (haystack.includes(q)) score += PHRASE_BONUS;
  return { match: true, score };
}

/**
 * Filter and sort items by fuzzy match score. `getText` is the full haystack
 * (label plus keywords, description, shortcut); `getLabel`, when given, confines
 * the subsequence fallback to the label. Without it the fallback runs on the
 * whole haystack.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
  getLabel?: (item: T) => string,
): T[] {
  if (!query) return items;
  return items
    .map((item) => {
      const text = getText(item);
      return { item, ...fuzzyMatch(query, text, getLabel ? getLabel(item) : text) };
    })
    .filter((r) => r.match)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}
