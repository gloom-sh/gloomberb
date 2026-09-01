import { truncateTextSegments } from "../../../utils/format";

export interface SnippetSegment {
  text: string;
  /** Inside a `<mark>` the server put around a matched term. */
  marked: boolean;
}

const MARK_TAG = /<(\/?)mark\s*>/gi;
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

/**
 * Decodes in one pass so `&amp;lt;` yields the literal `&lt;` rather than being
 * decoded twice into `<`.
 */
function decodeEntities(value: string): string {
  return value.replace(ENTITY, (match, decimal?: string, hex?: string, name?: string) => {
    if (decimal) return codePoint(Number.parseInt(decimal, 10)) ?? match;
    if (hex) return codePoint(Number.parseInt(hex, 16)) ?? match;
    return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? match;
  });
}

function codePoint(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return null;
  try {
    return String.fromCodePoint(value);
  } catch {
    return null;
  }
}

/** Snippets are rendered on one line, so every run of whitespace becomes a space. */
function flatten(value: string): string {
  return value.replace(/\s+/g, " ");
}

function pushSegment(segments: SnippetSegment[], text: string, marked: boolean): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.marked === marked) {
    last.text += text;
    return;
  }
  segments.push({ text, marked });
}

/**
 * Splits a server snippet into plain and matched runs.
 *
 * The server is the only writer of these tags, but a snippet is cut out of
 * arbitrary document text: a truncated fragment can end mid-tag, and an
 * unbalanced `</mark>` must not swallow the words around it. Unclosed marks run
 * to the end, stray closers are dropped, and nested marks stay one highlight.
 */
export function parseMarkedSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let depth = 0;
  let cursor = 0;

  MARK_TAG.lastIndex = 0;
  for (let match = MARK_TAG.exec(snippet); match; match = MARK_TAG.exec(snippet)) {
    pushSegment(segments, flatten(decodeEntities(snippet.slice(cursor, match.index))), depth > 0);
    depth = match[1] === "/" ? Math.max(0, depth - 1) : depth + 1;
    cursor = match.index + match[0].length;
  }
  pushSegment(segments, flatten(decodeEntities(snippet.slice(cursor))), depth > 0);

  const first = segments[0];
  if (first) first.text = first.text.replace(/^ +/, "");
  const last = segments[segments.length - 1];
  if (last) last.text = last.text.replace(/ +$/, "");
  return segments.filter((segment) => segment.text.length > 0);
}

export function snippetPlainText(snippet: string): string {
  return parseMarkedSnippet(snippet).map((segment) => segment.text).join("");
}

/** Distinct matched terms, so a document view can highlight them outside the snippet. */
export function snippetMatchTerms(snippet: string): string[] {
  const terms = new Set<string>();
  for (const segment of parseMarkedSnippet(snippet)) {
    const term = segment.marked ? segment.text.trim() : "";
    if (term) terms.add(term.toLowerCase());
  }
  return [...terms];
}

/**
 * Fits segments into a cell. Table cells normally get `fitTableCellText`, but a
 * highlighted snippet is many text nodes, so the clipping happens here instead.
 */
export function truncateSegments(segments: SnippetSegment[], width: number): SnippetSegment[] {
  return truncateTextSegments(segments, width, (ellipsis) => ({ text: ellipsis, marked: false }));
}

/** Splits plain text on the matched terms so a full chunk can show the same highlights. */
export function highlightTerms(text: string, terms: readonly string[]): SnippetSegment[] {
  const usable = terms.filter((term) => term.length > 0);
  if (usable.length === 0) return [{ text, marked: false }];

  const pattern = new RegExp(
    `(${usable.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|")})`,
    "gi",
  );
  const segments: SnippetSegment[] = [];
  let cursor = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    // A zero-width match would loop forever on the same index.
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    pushSegment(segments, text.slice(cursor, match.index), false);
    pushSegment(segments, match[0], true);
    cursor = match.index + match[0].length;
  }
  pushSegment(segments, text.slice(cursor), false);
  return segments.filter((segment) => segment.text.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
