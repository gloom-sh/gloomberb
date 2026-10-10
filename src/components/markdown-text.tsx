import { Box, Span, Text } from "../ui";
import { useState } from "react";
import { TextAttributes } from "../ui";
import { InlineTickerBadge } from "./ticker/badge";
import { tokenizeTickerText } from "../tickers/tokenizer";
import type { InlineTickerCatalogEntry } from "../state/hooks/inline-tickers";
import { colors } from "../theme/colors";
import { displayWidth } from "../utils/format";

export interface MarkdownTextProps {
  text: string;
  lineWidth?: number;
  catalog?: Record<string, InlineTickerCatalogEntry>;
  textColor?: string;
  openTicker?: (symbol: string) => void;
}

interface StyledSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  code?: boolean;
  color?: string;
}

interface ParsedLine {
  segments: StyledSegment[];
  heading?: boolean;
  indent?: number;
}

// A backslash escapes the punctuation markdown would read ("\\*" is a star), and
// an italic span may hold a bold one ("*covers **96%** of value*").
const INLINE_RE =
  /(\\(?<escaped>[\\`*_~#>[\]()-])|\*\*(?<bold>[^*]+)\*\*|(?<!\*)\*(?!\*)(?<italic>(?:[^*]|\*\*[^*]+\*\*)+?)\*(?!\*)|`(?<code>[^`]+)`|~~(?<strike>[^~]+)~~)/g;

function parseInlineMarkdown(text: string): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let cursor = 0;

  const pattern = new RegExp(INLINE_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index) });
    }
    if (match.groups?.escaped != null) {
      segments.push({ text: match.groups.escaped });
    } else if (match.groups?.bold != null) {
      segments.push({ text: match.groups.bold, bold: true });
    } else if (match.groups?.italic != null) {
      for (const inner of parseInlineMarkdown(match.groups.italic)) segments.push({ ...inner, italic: true });
    } else if (match.groups?.code != null) {
      segments.push({ text: match.groups.code, code: true });
    } else if (match.groups?.strike != null) {
      segments.push({ text: match.groups.strike, dim: true });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments;
}

function parseLine(line: string): ParsedLine {
  // Headings
  const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
  if (headingMatch) {
    return {
      heading: true,
      segments: [{ text: headingMatch[2]!, bold: true, color: colors.borderFocused }],
    };
  }

  // List items
  const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s(.*)$/);
  if (listMatch) {
    const indent = listMatch[1]!.length;
    const marker = listMatch[2]!;
    const content = listMatch[3]!;
    return {
      indent,
      segments: [
        { text: `${marker} `, bold: true, color: colors.borderFocused },
        ...parseInlineMarkdown(content),
      ],
    };
  }

  return { segments: parseInlineMarkdown(line) };
}

type TableAlign = "left" | "center" | "right";

interface MarkdownTable {
  header: string[];
  /** Null where the delimiter row sets no alignment. */
  align: Array<TableAlign | null>;
  rows: string[][];
}

type MarkdownBlock =
  | { kind: "line"; text: string }
  | { kind: "table"; table: MarkdownTable };

/** One rendered line of a table, already padded to its column widths. */
type TableLine = StyledSegment[];

const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_GAP = 2;
/** A long word (a URL, a hyphenated compound) breaks rather than claiming a whole column. */
const TABLE_WORD_MIN = 16;

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlign(cell: string): TableAlign | null {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : null;
}

const NUMERIC_CELL_RE = /^[(+\-\u2212]?[$\u20ac\u00a3\u00a5]?\d[\d,.]*\s?(%|[kmbtx]|bn)?\)?$/i;

/** A column of figures reads right-aligned unless the table says otherwise. */
function columnAlign(table: MarkdownTable, column: number): TableAlign {
  const explicit = table.align[column];
  if (explicit) return explicit;
  const values = table.rows
    .map((row) => parseInlineMarkdown(row[column] ?? "").map((segment) => segment.text).join("").trim())
    .filter((value) => value !== "" && value !== "-" && value !== "\u2014");
  return values.length > 0 && values.every((value) => NUMERIC_CELL_RE.test(value)) ? "right" : "left";
}

/**
 * Splits text into plain lines and GFM tables. A table needs a header row and a
 * delimiter row with matching cell counts, so a streamed answer shows its
 * header as text until the delimiter arrives.
 */
function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const delimiter = lines[index + 1];
    if (line.includes("|") && delimiter?.includes("|") && TABLE_DELIMITER_RE.test(delimiter)) {
      const header = splitTableRow(line);
      const align = splitTableRow(delimiter).map(tableAlign);
      if (header.length === align.length) {
        const rows: string[][] = [];
        let next = index + 2;
        while (next < lines.length && lines[next]!.trim() !== "" && lines[next]!.includes("|")) {
          const cells = splitTableRow(lines[next]!).slice(0, header.length);
          while (cells.length < header.length) cells.push("");
          rows.push(cells);
          next += 1;
        }
        blocks.push({ kind: "table", table: { header, align, rows } });
        index = next - 1;
        continue;
      }
    }
    blocks.push({ kind: "line", text: line });
  }
  return blocks;
}

function segmentsWidth(segments: StyledSegment[]): number {
  return segments.reduce((total, segment) => total + displayWidth(segment.text), 0);
}

/** Words keep their styling, and a word can span styles (`**QQQ**'s`). */
function cellWords(segments: StyledSegment[]): StyledSegment[][] {
  const words: StyledSegment[][] = [];
  let current: StyledSegment[] = [];
  for (const segment of segments) {
    for (const part of segment.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        if (current.length > 0) words.push(current);
        current = [];
      } else {
        current.push({ ...segment, text: part });
      }
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

interface StyledChar {
  char: string;
  source: StyledSegment;
}

function joinStyledChars(chars: StyledChar[]): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let source: StyledSegment | null = null;
  for (const { char, source: next } of chars) {
    if (next === source) {
      segments[segments.length - 1]!.text += char;
    } else {
      segments.push({ ...next, text: char });
      source = next;
    }
  }
  return segments;
}

/** Breaks after a hyphen or slash when one fits, so "Nasdaq-100-oriented" splits at a dash. */
function breakWord(word: StyledSegment[], width: number): StyledSegment[][] {
  if (segmentsWidth(word) <= width) return [word];
  const chars = word.flatMap((source) => Array.from(source.text).map((char) => ({ char, source })));
  const pieces: StyledSegment[][] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let used = 0;
    let softEnd = -1;
    while (end < chars.length) {
      const charWidth = displayWidth(chars[end]!.char);
      if (used > 0 && used + charWidth > width) break;
      used += charWidth;
      end += 1;
      if (chars[end - 1]!.char === "-" || chars[end - 1]!.char === "/") softEnd = end;
    }
    if (end < chars.length && softEnd > start) end = softEnd;
    pieces.push(joinStyledChars(chars.slice(start, end)));
    start = end;
  }
  return pieces;
}

function wrapCell(segments: StyledSegment[], width: number): TableLine[] {
  const lines: TableLine[] = [];
  let line: TableLine = [];
  let used = 0;
  for (const word of cellWords(segments)) {
    for (const piece of breakWord(word, width)) {
      const pieceWidth = segmentsWidth(piece);
      if (used > 0 && used + 1 + pieceWidth > width) {
        lines.push(line);
        line = [];
        used = 0;
      }
      if (used > 0) {
        line.push({ text: " " });
        used += 1;
      }
      line.push(...piece);
      used += pieceWidth;
    }
  }
  lines.push(line);
  return lines;
}

function padLine(line: TableLine, width: number, align: TableAlign): TableLine {
  const space = Math.max(0, width - segmentsWidth(line));
  const before = align === "right" ? space : align === "center" ? Math.floor(space / 2) : 0;
  const after = space - before;
  return [
    ...(before > 0 ? [{ text: " ".repeat(before) }] : []),
    ...line,
    ...(after > 0 ? [{ text: " ".repeat(after) }] : []),
  ];
}

/**
 * Natural widths when they fit. Otherwise the widest columns shrink first, so
 * a short label column keeps its width while long prose columns wrap. Returns
 * null when even the narrowest layout overflows.
 */
function tableColumnWidths(cells: StyledSegment[][][], lineWidth: number | undefined): number[] | null {
  const count = cells[0]?.length ?? 0;
  const natural = new Array<number>(count).fill(0);
  const minimum = new Array<number>(count).fill(1);
  for (const row of cells) {
    row.forEach((cell, column) => {
      natural[column] = Math.max(natural[column]!, segmentsWidth(cell));
      for (const word of cellWords(cell)) {
        minimum[column] = Math.max(minimum[column]!, Math.min(TABLE_WORD_MIN, segmentsWidth(word)));
      }
    });
  }
  if (lineWidth == null) return natural;
  const room = lineWidth - TABLE_GAP * (count - 1);
  const sum = (widths: number[]) => widths.reduce((total, width) => total + width, 0);
  if (sum(natural) <= room) return natural;
  if (sum(minimum) > room) return null;

  const capped = (cap: number) => natural.map((width, column) => Math.max(minimum[column]!, Math.min(width, cap)));
  let cap = Math.max(...natural);
  while (cap > 0 && sum(capped(cap)) > room) cap -= 1;
  const widths = capped(cap);
  let spare = room - sum(widths);
  for (let column = 0; spare > 0 && column < count; column += 1) {
    const give = Math.min(spare, natural[column]! - widths[column]!);
    widths[column]! += give;
    spare -= give;
  }
  return widths;
}

function layoutTableRows(
  rows: StyledSegment[][][],
  widths: number[],
  align: TableAlign[],
  indent = 0,
): TableLine[] {
  const lines: TableLine[] = [];
  for (const row of rows) {
    const wrapped = row.map((cell, column) => wrapCell(cell, widths[column]!));
    const height = Math.max(...wrapped.map((cellLines) => cellLines.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const line: TableLine = indent > 0 ? [{ text: " ".repeat(indent) }] : [];
      wrapped.forEach((cellLines, column) => {
        if (column > 0) line.push({ text: " ".repeat(TABLE_GAP) });
        line.push(...padLine(cellLines[lineIndex] ?? [], widths[column]!, align[column] ?? "left"));
      });
      lines.push(line);
    }
  }
  return lines;
}

function headerCell(text: string): StyledSegment[] {
  return parseInlineMarkdown(text).map((segment) => ({ ...segment, bold: true, color: colors.textDim }));
}

/**
 * Lays a table out as padded lines that fit `lineWidth`. A pane too narrow for
 * the columns gets one record per row instead: the first cell as a title, then
 * each other column as a labelled field.
 */
function layoutMarkdownTable(table: MarkdownTable, lineWidth?: number): TableLine[] {
  const header = table.header.map(headerCell);
  const body = table.rows.map((row) => row.map((cell) => parseInlineMarkdown(cell)));
  const align = table.header.map((_, column) => columnAlign(table, column));
  const widths = tableColumnWidths([header, ...body], lineWidth);
  if (widths) return layoutTableRows([header, ...body], widths, align);

  const width = Math.max(1, lineWidth ?? 1);
  const fieldIndent = 2;
  const labels = header.slice(1);
  const labelWidth = Math.max(1, Math.min(
    Math.max(...labels.map(segmentsWidth)),
    Math.floor((width - fieldIndent) / 3),
  ));
  const valueWidth = Math.max(1, width - fieldIndent - labelWidth - TABLE_GAP);
  const lines: TableLine[] = [];
  for (const row of body) {
    const title = row[0]!.map((segment) => ({ ...segment, bold: true }));
    if (title.length > 0) lines.push(...wrapCell(title, width));
    const fields = labels.map((label, index) => [label, row[index + 1]!]);
    lines.push(...layoutTableRows(fields, [labelWidth, valueWidth], ["left", "left"], fieldIndent));
  }
  return lines;
}

function wrappedTextStyle() {
  return {
    minWidth: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  } as const;
}

function wrappedInlineTextStyle() {
  return {
    ...wrappedTextStyle(),
    display: "inline",
  } as const;
}

function SegmentSpan({ segment, wrap = false }: { segment: StyledSegment; wrap?: boolean }) {
  const wrapProps = wrap
    ? {
        wrapText: true,
        wrapMode: "word",
        style: wrappedInlineTextStyle(),
      }
    : {};

  if (segment.code) {
    return <Span fg={colors.textDim} {...wrapProps}>{segment.text}</Span>;
  }
  const attrs =
    (segment.bold ? TextAttributes.BOLD : 0) |
    (segment.italic ? TextAttributes.ITALIC : 0) |
    (segment.dim ? TextAttributes.DIM : 0);
  return (
    <Span
      fg={segment.color ?? undefined}
      attributes={attrs || undefined}
      {...wrapProps}
    >
      {segment.text}
    </Span>
  );
}

function MarkdownLine({
  parsed,
  lineWidth,
  catalog,
  textColor,
  openTicker,
  hoveredSymbol,
  onHover,
}: {
  parsed: ParsedLine;
  lineWidth?: number;
  catalog: Record<string, InlineTickerCatalogEntry>;
  textColor: string;
  openTicker: (symbol: string) => void;
  hoveredSymbol: string | null;
  onHover: (symbol: string | null) => void;
}) {
  const indent = parsed.indent ?? 0;
  const indentStr = indent > 0 ? " ".repeat(indent) : "";
  const shouldWrap = lineWidth != null;
  const textWrapProps = shouldWrap
    ? {
        width: lineWidth,
        wrapText: true,
        wrapMode: "word",
        style: wrappedTextStyle(),
      }
    : {};

  // Check if any segment contains ticker symbols
  const fullText = parsed.segments.map((s) => s.text).join("");
  const tickerTokens = tokenizeTickerText(fullText);
  const hasTickers = tickerTokens.some((t) => t.kind === "ticker" && catalog[t.symbol]?.status !== "missing");

  if (!hasTickers) {
    // Simple case: no tickers, render as styled text
    return (
      <Text fg={textColor} {...textWrapProps}>
        {indentStr}
        {parsed.segments.map((segment, i) => (
          <SegmentSpan key={i} segment={segment} wrap={shouldWrap} />
        ))}
      </Text>
    );
  }

  // Complex case: need to handle tickers within styled segments
  // Render as a flex row to allow badge elements
  return (
    <Box flexDirection="row" flexWrap="wrap" {...(lineWidth != null ? { width: lineWidth } : {})}>
      {indentStr ? <Text fg={textColor}>{indentStr}</Text> : null}
      {parsed.segments.map((segment, segIdx) => {
        const tokens = tokenizeTickerText(segment.text);
        return tokens.map((token, tokIdx) => {
          if (token.kind === "text") {
            if (!token.value) return null;
            return (
              <Text
                key={`${segIdx}:${tokIdx}`}
                fg={textColor}
                {...(shouldWrap
                  ? { wrapText: true, wrapMode: "word", style: wrappedTextStyle() }
                  : {})}
              >
                <SegmentSpan segment={{ ...segment, text: token.value }} wrap={shouldWrap} />
              </Text>
            );
          }
          const entry = catalog[token.symbol];
          if (!entry || entry.status === "missing") {
            return (
              <Text
                key={`${segIdx}:${tokIdx}`}
                fg={textColor}
                {...(shouldWrap
                  ? { wrapText: true, wrapMode: "word", style: wrappedTextStyle() }
                  : {})}
              >
                <SegmentSpan segment={{ ...segment, text: token.value }} wrap={shouldWrap} />
              </Text>
            );
          }
          return (
            <InlineTickerBadge
              key={`badge:${segIdx}:${tokIdx}:${token.symbol}`}
              symbol={token.symbol}
              entry={entry}
              hovered={hoveredSymbol === token.symbol}
              onHoverStart={() => onHover(token.symbol)}
              onHoverEnd={() => onHover(null)}
              onOpen={openTicker}
            />
          );
        });
      })}
    </Box>
  );
}

export function MarkdownText({
  text,
  lineWidth,
  catalog = {},
  textColor = colors.text,
  openTicker = () => {},
}: MarkdownTextProps) {
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  const blocks = parseMarkdownBlocks(text);

  return (
    <Box flexDirection="column" {...(lineWidth != null ? { width: lineWidth } : {})}>
      {blocks.map((block, index) => {
        if (block.kind === "table") {
          return (
            <Box key={index} flexDirection="column">
              {layoutMarkdownTable(block.table, lineWidth).map((line, lineIndex) => (
                <Text key={lineIndex} fg={textColor}>
                  {line.map((segment, segmentIndex) => (
                    <SegmentSpan key={segmentIndex} segment={segment} />
                  ))}
                </Text>
              ))}
            </Box>
          );
        }
        const line = block.text;
        if (line.trim() === "") {
          return <Text key={index}>{" "}</Text>;
        }
        const parsed = parseLine(line);
        return (
          <MarkdownLine
            key={index}
            parsed={parsed}
            lineWidth={lineWidth}
            catalog={catalog}
            textColor={textColor}
            openTicker={openTicker}
            hoveredSymbol={hoveredSymbol}
            onHover={setHoveredSymbol}
          />
        );
      })}
    </Box>
  );
}
