/**
 * Text shaping for the call reader. Model summaries arrive as dense
 * paragraphs; on a wide pane they are a wall. Splitting them into one point
 * per sentence and setting the figures in bold is what makes them scannable.
 */

export interface ProseRun {
  text: string;
  /** A number the eye should land on: money, percentages, quantities. */
  figure: boolean;
}

/**
 * Money, percentages and quantities with a unit, plus bare numbers except
 * years. Ordinals and fiscal labels (Q2, FY26, 2Q) are left alone.
 */
const FIGURE_PATTERN =
  /[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:trillion|billion|million|thousand|bn|mn|k|m|b)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent(?:age points?)?|bps|basis points|x\b|trillion|billion|million|thousand)|\b\d[\d,]*(?:\.\d+)?\b/gi;

const YEAR_PATTERN = /^(?:19|20)\d{2}$/;

export function splitFigures(text: string): ProseRun[] {
  const runs: ProseRun[] = [];
  let last = 0;
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const start = match.index ?? 0;
    const value = match[0];
    if (YEAR_PATTERN.test(value)) continue;
    if (start > last) runs.push({ text: text.slice(last, start), figure: false });
    runs.push({ text: value, figure: true });
    last = start + value.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), figure: false });
  return runs;
}

/**
 * Sentence boundaries, minus the periods inside abbreviations ("U.S.",
 * "Inc.", "vs.") and figures ("$27.8 million").
 */
const SENTENCE_BOUNDARY =
  /(?<!\b(?:[A-Z]|Inc|Ltd|Co|Corp|vs|Mr|Ms|Mrs|Dr|No|St|Jr|Sr|U\.S|e\.g|i\.e|approx))[.!?]["”')]?\s+(?=["“(]?[A-Z0-9$])/;

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > 0) {
    const match = SENTENCE_BOUNDARY.exec(rest);
    if (!match) {
      out.push(rest);
      break;
    }
    // Keep the closing punctuation, drop the whitespace that followed it.
    const cut = match.index + match[0].trimEnd().length;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(match.index + match[0].length);
  }
  return out.filter(Boolean);
}
