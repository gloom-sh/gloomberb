/**
 * The markdown every renderer of it reads: inline marks (the reader, buildout
 * and Ask Gloom panes through components/markdown-text.tsx, and chat), and the
 * line structure chat draws (headings, lists, quotes and fenced code).
 */

export interface MarkdownSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** Where the segment links to, when links are read. */
  link?: string;
}

export interface InlineMarkdownOptions {
  /**
   * Reads `[label](href)` as a link: every one, or those whose href this
   * accepts. A link not read stays the text it was written as.
   */
  links?: boolean | ((href: string) => boolean);
}

// A backslash escapes the punctuation markdown would read ("\\*" is a star).
// A bracket after a bang is a picture, which stays as written. A bare address
// is read whole, so the underscores and stars in it are not marks. A mark
// opens before a character and closes after one, so "2 * 3 * 4" is
// arithmetic, and an underscore inside a word (snake_case, a_b_c) is not one.
// An italic span may hold a bold one ("*covers **96%** of value*").
const INLINE_RE = new RegExp([
  String.raw`\\(?<escaped>[\\` + "`" + String.raw`*_~#>[\]()-])`,
  String.raw`(?<!!)\[(?<linkLabel>[^\]]+)\]\((?<linkHref>(?:[^()\s]|\([^()\s]*\))+)\)`,
  String.raw`(?<url>\b(?:https?:\/\/|www\.)[^\s<>"']+)`,
  "(?<!`)(?<ticks>`{1,3})(?!`)(?<code>[^`]|[^`].*?[^`])\\k<ticks>(?!`)",
  String.raw`\*\*(?![\s*])(?<bold>[^*]+?)(?<!\s)\*\*`,
  String.raw`(?<!\*)\*(?![\s*])(?<italic>(?:[^*]|\*\*[^*]+\*\*)+?)(?<!\s)\*(?!\*)`,
  String.raw`(?<![A-Za-z0-9_])_(?![\s_])(?<underscored>[^_]+?)(?<!\s)_(?![A-Za-z0-9_])`,
  String.raw`~~(?![\s~])(?<strike>[^~]+?)(?<!\s)~~`,
].join("|"), "gi");

function readsLink(options: InlineMarkdownOptions, href: string): boolean {
  return typeof options.links === "function" ? options.links(href) : options.links === true;
}

/** Code keeps its text; one space inside each tick, as in "`` `a` ``", is padding. */
function codeText(code: string): string {
  return code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() ? code.slice(1, -1) : code;
}

export function parseInlineMarkdown(text: string, options: InlineMarkdownOptions = {}): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  const marked = (inner: string, mark: Partial<MarkdownSegment>) => {
    for (const segment of parseInlineMarkdown(inner, options)) segments.push({ ...segment, ...mark });
  };

  const pattern = new RegExp(INLINE_RE.source, INLINE_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const groups = match.groups ?? {};
    if (groups.linkHref != null && !readsLink(options, groups.linkHref)) {
      // Not read as a link: the bracket is text, and what is inside it still styles.
      pattern.lastIndex = match.index + 1;
      continue;
    }
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index) });
    }
    if (groups.escaped != null) {
      segments.push({ text: groups.escaped });
    } else if (groups.linkHref != null) {
      for (const inner of parseInlineMarkdown(groups.linkLabel ?? "")) segments.push({ ...inner, link: groups.linkHref });
    } else if (groups.url != null) {
      segments.push({ text: groups.url });
    } else if (groups.code != null) {
      segments.push({ text: codeText(groups.code), code: true });
    } else if (groups.bold != null) {
      marked(groups.bold, { bold: true });
    } else if (groups.italic != null) {
      marked(groups.italic, { italic: true });
    } else if (groups.underscored != null) {
      marked(groups.underscored, { italic: true });
    } else if (groups.strike != null) {
      marked(groups.strike, { strike: true });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  // Plain runs split by an address or an escape read as one.
  return segments.reduce<MarkdownSegment[]>((joined, segment) => {
    const previous = joined[joined.length - 1];
    if (previous && isPlain(previous) && isPlain(segment)) previous.text += segment.text;
    else joined.push({ ...segment });
    return joined;
  }, []);
}

function isPlain(segment: MarkdownSegment): boolean {
  return !segment.bold && !segment.italic && !segment.strike && !segment.code && segment.link === undefined;
}

export const MARKDOWN_HEADING_RE = /^(#{1,3})\s+(.+)$/;

const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s(.*)$/;

/** A list item's indent, marker ("-", "*" or "1.") and text, or null for any other line. */
export function markdownListItem(line: string): { indent: number; marker: string; text: string } | null {
  const match = line.match(LIST_ITEM_RE);
  return match ? { indent: match[1]!.length, marker: match[2]!, text: match[3]! } : null;
}

export type MarkdownLine =
  | { kind: "text"; text: string }
  | { kind: "blank" }
  | { kind: "heading"; text: string }
  | { kind: "list"; indent: number; marker: string; text: string }
  | { kind: "quote"; text: string }
  /** A line inside a fenced code block, as written. */
  | { kind: "code"; text: string };

const FENCE_OPEN_RE = /^\s{0,3}```[^`]*$/;
const FENCE_CLOSE_RE = /^\s{0,3}```\s*$/;
const QUOTE_RE = /^>(?: (.*))?$/;

/**
 * A message's lines and what each is. The fence lines of a code block are
 * dropped; a fence that never closes stays a line of text, so it cannot turn
 * the rest of the message into code.
 */
export function parseMarkdownLines(text: string): MarkdownLine[] {
  const lines = text.split("\n");
  const parsed: MarkdownLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (FENCE_OPEN_RE.test(line)) {
      const close = lines.findIndex((candidate, next) => next > index && FENCE_CLOSE_RE.test(candidate));
      if (close > index) {
        for (const code of lines.slice(index + 1, close)) parsed.push({ kind: "code", text: code });
        index = close;
        continue;
      }
    }
    if (line.trim() === "") {
      parsed.push({ kind: "blank" });
      continue;
    }
    const heading = line.match(MARKDOWN_HEADING_RE);
    if (heading) {
      parsed.push({ kind: "heading", text: heading[2]! });
      continue;
    }
    const quote = line.match(QUOTE_RE);
    if (quote) {
      parsed.push({ kind: "quote", text: quote[1] ?? "" });
      continue;
    }
    const item = markdownListItem(line);
    parsed.push(item ? { kind: "list", ...item } : { kind: "text", text: line });
  }
  return parsed;
}

/**
 * The text without its marks, for wherever it shows as one plain line (a
 * reply's quote, a notification). A link reads as its label.
 */
export function markdownPlainText(text: string, options: InlineMarkdownOptions = {}): string {
  const plain = (line: string) => parseInlineMarkdown(line, options).map((segment) => segment.text).join("");
  return parseMarkdownLines(text).map((line) => {
    switch (line.kind) {
      case "blank": return "";
      case "code": return line.text;
      case "list": return `${" ".repeat(line.indent)}${line.marker} ${plain(line.text)}`;
      default: return plain(line.text);
    }
  }).join("\n");
}
