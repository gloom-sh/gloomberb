import { useThemeColors } from "../../theme/theme-context";
import { TYPE, WEIGHT } from "../../theme/ui-tokens";
import { Box, StyledText, Text, TextAttributes } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { wrapTextLines } from "../../utils/text-wrap";
import { splitFigures } from "../ui/prose";
import type { ArticleBlock } from "./article-text";

/**
 * The reader's text: a paragraph, heading, list or table set at the reader's
 * measure in the terminal and in the reader's type on the desktop and the
 * web, where the browser wraps it. Shared by the article reader and the
 * detail reader of list panes.
 */

/**
 * The reader's type scale on the desktop and the web, one for every reader
 * (the article reader, the detail reader, Docs, and the markdown in them),
 * from the app's tokens (src/theme/ui-tokens.ts TYPE):
 *
 * | Level | Wide | Column under 480px |
 * |---|---|---|
 * | Metadata, label and value facts, tables, coverage | 12px, dimmer | 12px |
 * | Body, lead (bright, not bigger), and every prose bullet: key facts, list items, markdown | 14px, line height 1.6 | 13.2px |
 * | Section heading | 16px bold, bright, space above | 15.1px |
 * | Title | 20px bold | 18.9px |
 *
 * 14 to 16 is a 14% step, so a heading also differs by weight, colour and
 * the space above it. The body size comes from `--reader-em`, which a
 * container query in styles.css lowers in a narrow column, so a resize
 * changes it with the layout and nothing counts cells. The levels above it
 * are in em of it. A bullet is a dim dot two characters wide, its wrapped
 * lines hanging under the text, in the article reader and in markdown alike.
 */
export const READER_COLUMN_FONT = `calc(var(--reader-em, ${TYPE.body / TYPE.ui}) * 1em)`;
/** The reading measure: every reader centres its column at this width, in its own type. */
export const READER_MEASURE = "66ch";
/**
 * The one reading column: centred at the measure, the pane's inset on each
 * side, 12px above and 16px below. Readers that sit in a DetailScrollBody
 * (which already gives that inset) take only the measure.
 */
export const READER_COLUMN_STYLE = {
  width: "100%",
  maxWidth: `calc(${READER_MEASURE} + 2 * var(--gloom-inset))`,
  padding: "var(--gloom-space-md) var(--gloom-inset) var(--gloom-space-lg)",
  boxSizing: "border-box",
} as const;
/** Back to the app's own size inside a reading column: metadata, chips, controls, tables. */
export const READER_APP_FONT = "calc(1em / var(--reader-em, 1.1667))";
/** Line height of reading text on the desktop, against its own size. */
export const DESKTOP_LINE_HEIGHT = 1.6;
/** The space between two blocks of reading text (paragraphs, a list), in every reader. */
export const READER_PARAGRAPH_GAP = "0.9em";
/** A section heading in reading text: a step above the body, set apart by weight and the space above it. */
export const READER_HEADING_STYLE = { fontSize: `${TYPE.heading / TYPE.body}em`, fontWeight: WEIGHT.bold, lineHeight: 1.35, margin: "0.9em 0 0.4em" } as const;

export type Segment = { text: string; marked?: boolean; figure?: boolean };

export function figureSegments(text: string): Segment[] {
  return splitFigures(text).map((run) => ({ text: run.text, figure: run.figure }));
}

export interface ReaderGeometry {
  desktop: boolean;
  /** Terminal: characters per line. The desktop wraps in CSS. */
  measure: number;
  /** Terminal only: columns left of the text column, which is centred in the pane. */
  margin: number;
}

/** Columns padded to their widest cell; figures right-aligned, the first column left. */
function tableLines(rows: readonly string[][]): string[] {
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(...rows.map((row) => displayWidth(row[column] ?? ""))));
  return rows.map((row) => widths.map((width, column) => {
    const cell = row[column] ?? "";
    const pad = " ".repeat(Math.max(0, width - displayWidth(cell)));
    return column === 0 ? `${cell}${pad}` : `${pad}${cell}`;
  }).join("   ").trimEnd());
}

/** A first row without a figure in it is the table's header. */
function hasHeaderRow(rows: readonly string[][]): boolean {
  return rows.length > 1 && rows[0]!.every((cell) => !/\d[\d,.]*\s*%?$/.test(cell) || /^(?:Q[1-4]|FY|H[12])\s?'?\d{2,4}$/i.test(cell));
}

export type TextVariant = "headline" | "meta" | "lead" | "body" | "heading" | "label" | "fact" | "item";

/**
 * The role a reading block plays, the same in every reader (here, markdown,
 * Docs), for the pane chrome checks that hold the readers to one layout.
 */
const READER_ROLE: Partial<Record<TextVariant, string>> = { body: "reader-paragraph", heading: "reader-heading", label: "reader-heading" };

const DESKTOP_VARIANT_STYLE: Record<TextVariant, Record<string, string | number>> = {
  headline: { fontSize: `${TYPE.title / TYPE.body}em`, lineHeight: 1.25 },
  meta: { fontSize: READER_APP_FONT, lineHeight: 1.5 },
  // The body's size, set apart by its brighter colour (the caller) and the space after it.
  lead: { lineHeight: DESKTOP_LINE_HEIGHT, marginBottom: READER_PARAGRAPH_GAP },
  body: { lineHeight: DESKTOP_LINE_HEIGHT, marginBottom: READER_PARAGRAPH_GAP },
  heading: READER_HEADING_STYLE,
  // Names what follows (key facts, coverage): a section heading in all but name.
  label: READER_HEADING_STYLE,
  // A key fact is a sentence: a prose bullet at the body's size, as list items
  // and markdown and Docs bullets are, one after another with no space between.
  // Label and value facts (DetailReader) stay at the app's size.
  fact: { lineHeight: DESKTOP_LINE_HEIGHT },
  item: { lineHeight: DESKTOP_LINE_HEIGHT },
};

function styled(segments: readonly Segment[], color: string, markColor: string, figureColor: string | undefined, attributes: number): StyledText {
  return new StyledText(segments.map((segment) => ({
    text: segment.text,
    fg: segment.marked ? markColor : segment.figure && figureColor ? figureColor : color,
    // A search match is marked by colour alone; a fact's figures are also set bold.
    attributes: segment.figure && figureColor ? attributes | TextAttributes.BOLD : attributes,
  })));
}

/**
 * Text at the reader's measure. The terminal draws it pre-wrapped, a row per
 * line; the desktop lets the browser wrap it at the reading size of its variant.
 * Facts and list items hang under a bullet.
 */
export function ReaderText({
  text,
  geometry,
  color,
  bold = false,
  variant,
  segments,
  figureColor,
}: {
  text: string;
  geometry: ReaderGeometry;
  color: string;
  bold?: boolean;
  variant: TextVariant;
  segments?: readonly Segment[];
  figureColor?: string;
}) {
  const colors = useThemeColors();
  const attributes = bold || variant === "heading" ? TextAttributes.BOLD : TextAttributes.NONE;
  const bullet = variant === "fact" || variant === "item";
  if (geometry.desktop) {
    const content = segments
      ? styled(segments, color, colors.warning, figureColor, attributes)
      : undefined;
    const textNode = (
      <Text
        fg={color}
        attributes={attributes}
        wrapText
        selectable
        width="100%"
        style={{ display: "block", ...DESKTOP_VARIANT_STYLE[variant] }}
        content={content}
        data-gloom-role={READER_ROLE[variant]}
      >
        {content ? undefined : text}
      </Text>
    );
    if (!bullet) return textNode;
    return (
      <Box flexDirection="row" width="100%" data-gloom-role="reader-bullet">
        <Text fg={colors.textDim} style={{ fontSize: DESKTOP_VARIANT_STYLE[variant].fontSize, lineHeight: DESKTOP_VARIANT_STYLE[variant].lineHeight, width: "2ch", flexShrink: 0 }}>{"\u2022"}</Text>
        <Box flexGrow={1} minWidth={0}>{textNode}</Box>
      </Box>
    );
  }
  const prefix = bullet ? "\u2022 " : "";
  const lines = wrapTextLines(text, Math.max(8, geometry.measure - prefix.length));
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={index} height={1} flexDirection="row">
          {prefix ? <Text fg={colors.textDim}>{index === 0 ? prefix : "  "}</Text> : null}
          {/* Always styled content: a terminal text node cannot switch from content to children in place. */}
          <Text content={styled(segments ? lineSegments(segments, line, lines, index, text) : [{ text: line }], color, colors.warning, figureColor, attributes)} />
        </Box>
      ))}
    </Box>
  );
}

/**
 * The segments that fall on one pre-wrapped line. Wrapping drops the spaces
 * it breaks at, so each line is found in the text by its position rather than
 * by counting characters.
 */
function lineSegments(segments: readonly Segment[], line: string, lines: readonly string[], lineIndex: number, text: string): Segment[] {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset = text.indexOf(lines[index]!, offset) + lines[index]!.length;
  }
  const start = text.indexOf(line, offset);
  const end = start + line.length;
  const result: Segment[] = [];
  let position = 0;
  for (const segment of segments) {
    const segmentEnd = position + segment.text.length;
    const from = Math.max(start, position);
    const to = Math.min(end, segmentEnd);
    if (to > from) result.push({ ...segment, text: text.slice(from, to) });
    position = segmentEnd;
  }
  return result.length > 0 ? result : [{ text: line }];
}

export function ReaderBlock({
  block,
  geometry,
  segments,
}: {
  block: ArticleBlock;
  geometry: ReaderGeometry;
  segments?: Segment[];
}) {
  const colors = useThemeColors();
  switch (block.kind) {
    case "heading":
      return <ReaderText text={block.text} geometry={geometry} color={colors.textBright} variant="heading" />;
    case "paragraph":
      return <ReaderText text={block.text} geometry={geometry} color={colors.text} variant="body" segments={segments} />;
    case "list":
      return (
        <Box flexDirection="column" style={geometry.desktop ? { marginBottom: READER_PARAGRAPH_GAP } : undefined}>
          {block.items.map((item, index) => (
            <ReaderText key={index} text={item} geometry={geometry} color={colors.text} variant="item" />
          ))}
        </Box>
      );
    case "table":
      return <ReaderTable rows={block.rows} geometry={geometry} />;
  }
}

/**
 * A table set in columns. The app's type is monospace on every host, so
 * padding the cells lines them up; a table wider than the column scrolls
 * sideways on the desktop and is cut at the edge in the terminal.
 */
function ReaderTable({ rows, geometry }: { rows: readonly string[][]; geometry: ReaderGeometry }) {
  const colors = useThemeColors();
  const lines = tableLines(rows);
  const header = hasHeaderRow(rows);
  if (geometry.desktop) {
    return (
      // At the app's own size, as its tables are: a reading-size table runs out of a narrow pane.
      <Box flexDirection="column" width="100%" style={{ overflowX: "auto", margin: "0.2em 0 1.3em", fontSize: READER_APP_FONT, lineHeight: 1.9 }}>
        {lines.map((line, index) => (
          <Text
            key={index}
            fg={index === 0 && header ? colors.textDim : colors.text}
            attributes={index === 0 && header ? TextAttributes.BOLD : TextAttributes.NONE}
            selectable
            style={{ display: "block", lineHeight: "inherit", whiteSpace: "pre", borderBottom: index === 0 && header ? `1px solid ${colors.border}` : undefined }}
          >
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={index} height={1}>
          <Text
            fg={index === 0 && header ? colors.textDim : colors.text}
            attributes={index === 0 && header ? TextAttributes.BOLD : TextAttributes.NONE}
          >
            {truncateToDisplayWidth(line, geometry.measure)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

