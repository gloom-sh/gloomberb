/**
 * Turns the text of an indexed article, call or filing into blocks a reader
 * can lay out: paragraphs of a few sentences, headings, lists and tables, with
 * web page chrome and wire boilerplate left out.
 *
 * Everything here is extractive. Lines are dropped only when they match a
 * known kind of page furniture as a whole ("Share this article", a cookie
 * banner, the headline printed again), sentences are never reworded, and a
 * paragraph is split only between sentences. When a rule is unsure it keeps
 * the text: a stray share link costs a glance, a lost sentence costs the
 * story. The reader keeps the raw text one action away for the same reason.
 */

export type ArticleBlock =
  | { kind: "paragraph"; text: string; section: number }
  | { kind: "heading"; text: string; section: number }
  | { kind: "list"; items: string[]; section: number }
  | { kind: "table"; rows: string[][]; section: number };

export interface ArticleSection {
  text: string;
  /** Who or what the section is: a speaker, a filing section. Shown as its heading when it changes. */
  heading?: string;
}

export interface ParseArticleOptions {
  /** The headline, dropped where the page prints it again. */
  title?: string;
  /** The publisher or wire, dropped where the page prints it again. */
  source?: string;
  /**
   * Leave out web page chrome and wire boilerplate. For news; a transcript or
   * a filing is kept as written.
   */
  clean?: boolean;
}

/** About three lines at a reading measure: the most a paragraph should hold. */
const PARAGRAPH_TARGET_WORDS = 45;
/** How far into an article page furniture (bylines, datelines, share rows) is looked for. */
const HEADER_LINES = 10;

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.,$%&/-]*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// Sentences

/**
 * Words that end in a period without ending the sentence. Lowercased, without
 * the period. Initials (J.), dotted acronyms (U.S.) and months are covered by
 * patterns below.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "ft", "ave", "blvd",
  "inc", "corp", "co", "ltd", "plc", "llc", "lp", "bros", "dept", "no", "nos",
  "vs", "etc", "approx", "est", "fig", "gov", "sen", "rep", "gen", "lt", "col",
  "capt", "sgt", "rev", "hon", "pres", "vol", "op", "cf", "al",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

function endsWithAbbreviation(before: string): boolean {
  const token = /(\S+)$/.exec(before)?.[1] ?? "";
  const bare = token.replace(/^[("'“‘[]+/, "");
  // "J." and "U.S." and "e.g.": a dot inside the word, or a single letter.
  if (/^\p{L}$/u.test(bare)) return true;
  if (/^(?:\p{L}\.)+\p{L}?$/u.test(bare)) return true;
  return ABBREVIATIONS.has(bare.toLowerCase());
}

/**
 * Splits text into sentences at a period, question or exclamation mark
 * (with any closing quote or bracket) followed by a space and a capital,
 * an opening quote or a bracket. Never after an abbreviation or an initial,
 * and never before a digit, so "No. 5" and "Oct. 10" hold together. Unsure
 * cases stay one sentence: a missed break costs nothing in a reader.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const boundary = /([.!?\u2026]+["'\u201d\u2019)\]]*)\s+(?=["'\u201c\u2018(\[]?\p{Lu})/gu;
  let start = 0;
  for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
    const punctuation = match[1]!;
    // "Inc." or "U.S." before a name is part of the sentence; an ellipsis is not an abbreviation.
    if (punctuation[0] === "." && !punctuation.startsWith("..") && endsWithAbbreviation(text.slice(start, match.index))) continue;
    const sentence = text.slice(start, match.index + punctuation.length).trim();
    if (sentence) sentences.push(sentence);
    start = match.index + match[0].length;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

/**
 * Where to break `counts` (words per sentence) into `groups` runs so each run
 * is as close to the same size as it can be: a linear partition, small enough
 * to solve exactly for any paragraph a page holds.
 */
function balancedBreaks(counts: number[], groups: number): number[] {
  const n = counts.length;
  const prefix = [0];
  for (const count of counts) prefix.push(prefix[prefix.length - 1]! + count);
  const budget = prefix[n]! / groups;
  const cost = (from: number, to: number) => (prefix[to]! - prefix[from]! - budget) ** 2;
  // best[g][j]: the least cost of the first j sentences in g runs; from[g][j]: where its last run starts.
  const best = Array.from({ length: groups + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from = Array.from({ length: groups + 1 }, () => new Array<number>(n + 1).fill(0));
  best[0]![0] = 0;
  for (let g = 1; g <= groups; g += 1) {
    for (let j = g; j <= n; j += 1) {
      for (let i = g - 1; i < j; i += 1) {
        const value = best[g - 1]![i]! + cost(i, j);
        if (value < best[g]![j]!) {
          best[g]![j] = value;
          from[g]![j] = i;
        }
      }
    }
  }
  const breaks: number[] = [];
  for (let g = groups, j = n; g > 0; g -= 1) {
    j = from[g]![j]!;
    breaks.unshift(j);
  }
  return breaks;
}

/**
 * Splits a long paragraph between sentences into runs of about
 * `targetWords`, as even as the sentences allow. A paragraph within a third
 * of the target, or one long sentence, stays whole.
 */
export function splitParagraph(text: string, targetWords = PARAGRAPH_TARGET_WORDS): string[] {
  const total = countWords(text);
  if (total <= Math.round(targetWords * 4 / 3)) return [text];
  const sentences = splitSentences(text);
  if (sentences.length < 2) return [text];
  const counts = sentences.map(countWords);
  const groups = Math.min(sentences.length, Math.ceil(total / targetWords));
  const breaks = balancedBreaks(counts, groups);
  return breaks.map((start, index) => sentences.slice(start, breaks[index + 1] ?? sentences.length).join(" "));
}

// ---------------------------------------------------------------------------
// Page furniture

const SHARE_TARGETS = "x|twitter|facebook|linkedin|email|e-mail|whatsapp|reddit|threads|bluesky|telegram|pinterest|mastodon";

/** Whole lines that are page chrome wherever they appear. Matched case-insensitively against the trimmed line. */
const CHROME_LINES: RegExp[] = [
  /^share (?:this|the) (?:article|story|post|page)$/,
  new RegExp(`^share (?:to|on|via|with) (?:${SHARE_TARGETS})$`),
  new RegExp(`^(?:${SHARE_TARGETS})$`),
  /^(?:share|tweet|print|copy link|copy url|save|bookmark|print this (?:page|article)|email this (?:page|article))$/,
  /^(?:advertisement|sponsored(?: content)?|ad|story continues below(?: advertisement)?)$/,
  /^(?:listen to (?:this )?(?:article|story)|\d+\s*min(?:ute)?s?\s+read)$/,
  /^(?:accept|accept all|accept all cookies|accept cookies|reject all|manage (?:cookie )?preferences|cookie settings|cookie policy)$/,
  /^view (?:the )?original content\b.*$/,
  /^(?:skip to (?:main )?content|back to top|return to top)$/,
  /^follow us on\b.{0,60}$/,
  /^(?:related(?: articles| stories| news)?|recommended(?: for you)?|more from [\p{L}\s]{1,30}|trending(?: now)?|see also)\s*:?$/u,
];

/** Lines that are page chrome only when they are short: a full sentence that mentions cookies is not a banner. */
function isShortChrome(line: string, words: number): boolean {
  const lower = line.toLowerCase();
  if (words <= 40 && /\b(?:(?:we|this (?:site|website)|our (?:site|website)) uses? cookies|use of cookies|accept (?:all )?cookies|cookie (?:policy|preferences|settings|consent|notice))\b/.test(lower)) return true;
  if (words <= 16 && /^(?:subscribe|sign up|join)\b/.test(lower) && /\b(?:newsletter|updates|alerts|inbox|our|free)\b/.test(lower)) return true;
  if (words <= 12 && /^(?:click here|tap here)\b/.test(lower)) return true;
  return false;
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_TEXT = `(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+)?(?:${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}\\s+${MONTH}\\.?,?\\s+\\d{4}|\\d{1,4}[/-]\\d{1,2}[/-]\\d{1,4})`;
const TIME_TEXT = "(?:,?\\s*(?:at\\s+)?\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?(?:\\s*[a-z]{2,4})?)?";
/** A line that is only a date and maybe a time: the reader's header already says when. */
const DATE_LINE = new RegExp(`^(?:(?:updated|published|posted|last updated)(?: on)?:?\\s*)?${DATE_TEXT}${TIME_TEXT}$`, "i");

/**
 * The dateline a wire story opens with: a place in capitals, an optional
 * date, then the wire's name, then a dash. "BOSTON, Oct. 9, 2026 /Wirefeed/ --",
 * "NEW YORK, Oct. 9, 2026 (GLOBE NEWSWIRE) --", "SAN FRANCISCO--(BUSINESS WIRE)--".
 * Only taken with the wire tag present, so an ordinary opening in capitals stays.
 */
const WIRE_DATELINE = new RegExp(
  "^[A-Z][A-Z .,'’&-]{1,60}(?:,\\s*[A-Z][A-Za-z.]{1,15}\\.?)?\\s*,?\\s*"
  + `(?:${DATE_TEXT}\\s*)?`
  + "(?:/[^/\\n]{2,40}/|\\([A-Z][A-Z .&-]{2,40}\\)|--\\([A-Z][A-Z .&-]{2,40}\\))\\s*(?:--|—|–|-)\\s*",
  "i",
);

function stripWireDateline(line: string): string {
  const match = WIRE_DATELINE.exec(line);
  if (!match) return line;
  // The place has to be in capitals; the "i" flag only loosens the date.
  const place = /^[^,/(-]+/.exec(match[0])?.[0] ?? "";
  if (place !== place.toUpperCase()) return line;
  const rest = line.slice(match[0].length).trim();
  return rest.length > 0 ? rest : line;
}

interface CleanContext {
  title: string;
  source: string;
}

/**
 * Lines of the page with chrome removed. `inHeader` lines (the top of the
 * article) also lose a repeated headline or source, a date standing alone,
 * and the "News provided by" credit with the name under it.
 */
function cleanLines(lines: string[], context: CleanContext, startIndex: number): string[] {
  const kept: string[] = [];
  let skipNextName = false;
  for (const [offset, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) {
      kept.push("");
      continue;
    }
    const lower = line.toLowerCase();
    const words = countWords(line);
    const inHeader = startIndex + offset < HEADER_LINES;
    if (skipNextName) {
      skipNextName = false;
      // The credited name: short, and no sentence in it ("Acme Inc." is a name).
      if (words <= 6 && (!/[.!?]$/.test(line) || endsWithAbbreviation(line.slice(0, -1)))) continue;
    }
    if (/^(?:news|content|story) provided by\b:?$/i.test(line)) {
      skipNextName = true;
      continue;
    }
    if (CHROME_LINES.some((pattern) => pattern.test(lower))) continue;
    if (isShortChrome(line, words)) continue;
    if (inHeader) {
      const key = normalizeKey(line);
      if (context.title && key === context.title) continue;
      if (context.source && key === context.source) continue;
      if (words <= 12 && DATE_LINE.test(line)) continue;
    }
    // "SOURCE Acme Inc." closes a wire release: who sent it, said again.
    if (/^SOURCE\s+\S/.test(line) && words <= 8) continue;
    kept.push(inHeader ? stripWireDateline(line) : line);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Blocks

const LIST_ITEM = /^(?:[•·▪●◦‣∙*]|[-–—](?=\s)|\d{1,2}[.)](?=\s))\s*(.+)$/u;
const TABLE_SPLIT = /\t+|\s{2,}|\s*\|\s*/;
const TERMINAL = /[.!?:;,"”’)\]…]$/u;

function tableCells(line: string): string[] | null {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  const cells = trimmed.split(TABLE_SPLIT).map((cell) => cell.trim()).filter((cell) => cell.length > 0);
  return cells.length >= 2 ? cells : null;
}

/** Collapses runs of spaces and tidies the gaps wire text leaves inside brackets. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\],;])/g, "$1")
    .trim();
}

type RawBlock =
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; rows: string[][] };

/**
 * Groups cleaned lines into blocks. A blank line always ends a block. Where
 * the source never uses blank lines, every line is its own block, except a
 * line that plainly continues the one before (it starts in lowercase after a
 * line with no closing punctuation). Where it does use them, single line
 * breaks inside a block are soft wraps.
 */
function groupLines(lines: string[]): RawBlock[] {
  const blankSeparated = lines.some((line, index) => line === "" && index > 0 && index < lines.length - 1);
  const blocks: RawBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line) {
      index += 1;
      continue;
    }
    // A run of two or more lines that split into the same number of cells.
    const cells = tableCells(line);
    if (cells) {
      const rows = [cells];
      let next = index + 1;
      while (next < lines.length) {
        const nextCells = lines[next] ? tableCells(lines[next]!) : null;
        if (!nextCells || nextCells.length !== cells.length) break;
        rows.push(nextCells);
        next += 1;
      }
      if (rows.length >= 2) {
        blocks.push({ kind: "table", rows });
        index = next;
        continue;
      }
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const items = [tidy(item[1]!)];
      let next = index + 1;
      while (next < lines.length) {
        const nextItem = lines[next] ? LIST_ITEM.exec(lines[next]!) : null;
        if (!nextItem) break;
        items.push(tidy(nextItem[1]!));
        next += 1;
      }
      // One dash-led line is a sentence, not a list.
      if (items.length >= 2 || !/^[-–—]/.test(line)) {
        blocks.push({ kind: "list", items });
        index = next;
        continue;
      }
    }
    let text = line;
    let next = index + 1;
    while (next < lines.length && lines[next]) {
      const following = lines[next]!;
      if (LIST_ITEM.test(following) || tableCells(following)) break;
      const continues = blankSeparated || (!TERMINAL.test(text) && /^[\p{Ll}\d($€£¥%&,;]/u.test(following));
      if (!continues) break;
      text = `${text} ${following}`;
      next += 1;
    }
    blocks.push({ kind: "text", text: tidy(text) });
    index = next;
  }
  return blocks;
}

/** Bullets run together on one line: "Highlights: • Revenue up 8% • Margin 46%". */
function splitInlineBullets(text: string): { lead: string; items: string[] } | null {
  const parts = text.split(/\s+[•▪●]\s+/u);
  if (parts.length < 3) return null;
  const [lead, ...items] = parts;
  return { lead: lead!.replace(/^[•▪●]\s*/u, "").trim(), items: items.map(tidy).filter(Boolean) };
}

/**
 * A short line with no closing punctuation, followed by a paragraph, reads as
 * the heading of what follows: a company name before its news, "Outlook"
 * before the guidance.
 */
function isHeading(text: string, next: RawBlock | undefined): boolean {
  if (!next || next.kind !== "text") return false;
  if (TERMINAL.test(text) && !/\)$/.test(text)) return false;
  if (text.length > 90 || countWords(text) > 12) return false;
  if (!/^[\p{Lu}\d"“]/u.test(text)) return false;
  return countWords(next.text) > countWords(text) * 2;
}

export function parseArticle(sections: ArticleSection[], options: ParseArticleOptions = {}): ArticleBlock[] {
  const context: CleanContext = {
    title: options.title ? normalizeKey(options.title) : "",
    source: options.source ? normalizeKey(options.source) : "",
  };
  const blocks: ArticleBlock[] = [];
  let lineIndex = 0;
  let previousHeading: string | undefined;
  for (const [section, entry] of sections.entries()) {
    const heading = entry.heading?.trim();
    if (heading && heading !== previousHeading) {
      blocks.push({ kind: "heading", text: heading, section });
    }
    previousHeading = heading || previousHeading;
    const rawLines = (entry.text ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
    const lines = options.clean ? cleanLines(rawLines, context, lineIndex) : rawLines.map((line) => line.trim());
    lineIndex += rawLines.length;
    const grouped = groupLines(lines);
    for (const [index, raw] of grouped.entries()) {
      if (raw.kind === "table") {
        blocks.push({ kind: "table", rows: raw.rows, section });
        continue;
      }
      if (raw.kind === "list") {
        blocks.push({ kind: "list", items: raw.items, section });
        continue;
      }
      const inline = splitInlineBullets(raw.text);
      if (inline) {
        if (inline.lead) blocks.push({ kind: "paragraph", text: inline.lead, section });
        blocks.push({ kind: "list", items: inline.items, section });
        continue;
      }
      if (isHeading(raw.text, grouped[index + 1])) {
        blocks.push({ kind: "heading", text: raw.text, section });
        continue;
      }
      for (const paragraph of splitParagraph(raw.text)) {
        blocks.push({ kind: "paragraph", text: paragraph, section });
      }
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Gist

export interface ArticleGist {
  /** The opening paragraph, or the article's own summary. */
  lead: string | null;
  /** Up to three sentences of the article that each carry a figure and a move. */
  facts: string[];
  /** What follows the lead. */
  body: ArticleBlock[];
  words: number;
}

/** Articles shorter than this are read whole; a facts list would only repeat them. */
const FACTS_MIN_WORDS = 250;
const MAX_FACTS = 3;
const FACT_FIGURE = /(?:[$€£¥]|\b[A-Z]{2,3}\$)\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|bps\b|basis points\b)/;
const FACT_MOVE = /\b(?:rose|rise[sn]?|fell|fall(?:s|en)?|gain(?:ed|s)?|lost|los(?:e|es|ing)|declin(?:ed|es|e)|increas(?:ed|es|e)|decreas(?:ed|es|e)|grew|grow(?:s|n)?|jump(?:ed|s)?|sl(?:id|ides?)|climb(?:ed|s)?|drop(?:ped|s)?|surg(?:ed|es)|plung(?:ed|es)|soar(?:ed|s)|tumbl(?:ed|es)|up|down|higher|lower|record|raised|cut|reported|guided)\b/i;
/** Openings that need the sentence before them to make sense. */
const DEPENDENT_OPENING = /^(?:it|its|they|their|this|that|these|those|he|she|his|her|we|our|but|and|so|also|however|meanwhile|the (?:company|stock|firm|group|index|shares))\b/i;

function isFact(sentence: string): boolean {
  const words = countWords(sentence);
  if (words < 6 || words > 30) return false;
  if (!/[.!]$/.test(sentence)) return false;
  if (DEPENDENT_OPENING.test(sentence)) return false;
  // Someone or something named, past the first word.
  if (!/\s\p{Lu}[\p{Ll}\p{Lu}]/u.test(sentence) && !/^\p{Lu}[\p{Ll}]+\s/u.test(sentence)) return false;
  return FACT_FIGURE.test(sentence) && FACT_MOVE.test(sentence);
}

export function articleGist(blocks: ArticleBlock[], options: { summary?: string | null } = {}): ArticleGist {
  const words = blocks.reduce((sum, block) => sum + blockWords(block), 0);
  const summary = options.summary?.trim() ? tidy(options.summary) : null;
  const firstIndex = blocks.findIndex((block) => block.kind === "paragraph");
  const first = firstIndex >= 0 ? blocks[firstIndex] as Extract<ArticleBlock, { kind: "paragraph" }> : null;
  // Only an opening paragraph leads: one that comes after a heading belongs to that heading.
  const opensWithParagraph = first !== null && blocks.slice(0, firstIndex).every((block) => block.kind !== "heading");

  let lead: string | null = null;
  let body = blocks;
  if (summary && (!first || normalizeKey(summary) !== normalizeKey(first.text))) {
    lead = summary;
  } else if (first && opensWithParagraph) {
    lead = first.text;
    body = blocks.filter((_, index) => index !== firstIndex);
  }

  const facts: string[] = [];
  if (words >= FACTS_MIN_WORDS) {
    const leadKey = lead ? normalizeKey(lead) : "";
    for (const block of body) {
      if (block.kind !== "paragraph") continue;
      // One per paragraph, so the list spans the story instead of one passage.
      const fact = splitSentences(block.text).find((sentence) => isFact(sentence) && !leadKey.includes(normalizeKey(sentence)));
      if (fact) facts.push(fact);
      if (facts.length === MAX_FACTS) break;
    }
  }
  return { lead, facts: facts.length >= 2 ? facts : [], body, words };
}

export function blockWords(block: ArticleBlock): number {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return countWords(block.text);
    case "list":
      return block.items.reduce((sum, item) => sum + countWords(item), 0);
    case "table":
      return block.rows.reduce((sum, row) => sum + row.reduce((cells, cell) => cells + countWords(cell), 0), 0);
  }
}

// ---------------------------------------------------------------------------
// Tickers

/** US venues only: a symbol from another exchange can name a different company here. */
const US_VENUE = /\b(?:NYSE American|NYSE Arca|NYSE MKT|NYSE|Nasdaq(?:GS|GM|CM)?|NASDAQ(?:GS|GM|CM)?|AMEX|Cboe BZX|OTCQX|OTCQB|OTC Pink|OTC)\s*:\s*([A-Z][A-Z0-9]{0,5}(?:\.[A-Z])?)\b/g;

/**
 * Symbols a release names with their listing, "(NASDAQ: ABCD)", in the order
 * they first appear. A bare capitalised word is never taken for a ticker.
 */
export function listedTickers(text: string): string[] {
  const symbols: string[] = [];
  for (const group of text.matchAll(/\(([^()]{3,80})\)/g)) {
    for (const match of group[1]!.matchAll(US_VENUE)) {
      const symbol = match[1]!;
      if (!symbols.includes(symbol)) symbols.push(symbol);
    }
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Search terms

/**
 * Splits text on the terms a search matched, case-insensitively, the longest
 * term first so "free cash flow" is one mark rather than "cash" inside it.
 */
export function markTerms(text: string, terms: readonly string[]): Array<{ text: string; marked: boolean }> {
  const usable = terms.map((term) => term.trim()).filter((term) => term.length > 0);
  if (usable.length === 0) return [{ text, marked: false }];
  const pattern = new RegExp(
    `(${usable.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")})`,
    "gi",
  );
  const keys = new Set(usable.map((term) => term.toLowerCase()));
  return text.split(pattern).filter((part) => part.length > 0).map((part) => ({ text: part, marked: keys.has(part.toLowerCase()) }));
}
