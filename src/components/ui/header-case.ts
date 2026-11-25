/**
 * Table headers read in one case everywhere, whatever case a pane wrote them
 * in. Greek letters keep theirs: σ and Σ mean different things.
 */
export function headerCase(label: string): string {
  return label.replace(/[^Ͱ-Ͽ]+/g, (run) => run.toLocaleUpperCase());
}

/** Short words a title keeps in lower case unless they open or close it. */
const MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor",
  "of", "on", "or", "per", "the", "to", "via", "vs", "with",
]);

/**
 * Section headings read in title case. A lower-case word is capitalised
 * (`By function` reads `By Function`); a word with any capital is kept as
 * written, so acronyms and names survive (`EPS comparison`, `iShares`).
 */
export function titleCase(label: string): string {
  const parts = label.split(/([\s/]+)/);
  const words = parts.flatMap((part, index) => (index % 2 === 0 && part ? [index] : []));
  const first = words[0];
  const last = words.at(-1);
  return parts.map((part, index) => {
    if (index % 2 === 1 || !/^[a-z][^A-Z]*$/.test(part)) return part;
    if (index !== first && index !== last && MINOR_WORDS.has(part)) return part;
    return part[0]!.toLocaleUpperCase() + part.slice(1);
  }).join("");
}
