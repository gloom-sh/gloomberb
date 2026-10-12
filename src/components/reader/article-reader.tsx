import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useShortcut } from "../../react/input";
import { scrollByLines } from "../../state/pane-scroll-registry";
import { useThemeColors } from "../../theme/theme-context";
import {
  Box,
  ScrollBox,
  StyledText,
  Text,
  TextAttributes,
  useNativeRenderer,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../ui";
import { t } from "../../i18n";
import { isPlainKey } from "../../utils/keyboard";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { wrapTextLines } from "../../utils/text-wrap";
import { usePaneFooter, usePaneMenuItems, type PaneHint } from "../layout/pane/footer";
import { TickerBadgeList } from "../ticker/badge/list";
import { ActionRow } from "../ui/action-row";
import { titleCase } from "../ui/header-case";
import { splitFigures } from "../ui/prose";
import { blockWords, markTerms, type ArticleBlock } from "./article-text";

/**
 * The longest line the reader sets, in characters. Past about 70 the eye
 * loses its place on the way back to the start of the next line.
 */
const TERMINAL_MEASURE = 72;
const DESKTOP_MEASURE_CH = 66;
/**
 * The reading size on the desktop against the app's own (12px by default):
 * 17.4px, or 16.2px in a pane under 480px, where a phone sets its body.
 */
const DESKTOP_FONT_EM = 1.45;
const DESKTOP_NARROW_FONT_EM = 1.35;
const DESKTOP_NARROW_CELLS = 60;
const DESKTOP_LINE_HEIGHT = 1.65;
/** Fewer hidden words than this are shown rather than tucked behind Read more. */
const COLLAPSE_MIN_HIDDEN_WORDS = 80;
const MAX_TICKERS = 6;
const NO_BLOCKS: readonly ArticleBlock[] = [];

export interface ArticleReaderProps {
  /** Which article this is. Scroll, Read more and the original text view start over when it changes. */
  articleKey: string;
  /** The headline. Left out where the pane's own title already is the headline. */
  title?: string | null;
  /** Source, time and kind, in that order. Empty parts are left out. */
  meta: ReadonlyArray<string | null | undefined>;
  tickers?: readonly string[];
  /** The opening paragraph or the article's own summary, set larger than the body. */
  lead?: string | null;
  /** Sentences of the article that carry its figures, listed under the lead. */
  facts?: readonly string[];
  body: readonly ArticleBlock[];
  /** The text as indexed, for "Show original text". */
  rawText?: string | null;
  /** Terms to mark in one section of the text: where a search matched. */
  highlight?: { section: number; terms: readonly string[] } | null;
  /** A section to bring into view on open, when it is not the first. */
  revealSection?: number | null;
  focused: boolean;
  width: number;
  height: number;
  onNext?: (() => void) | null;
  onPrevious?: (() => void) | null;
  /** After the text, such as a story's coverage by other outlets, under `childrenLabel`. */
  children?: ReactNode;
  childrenLabel?: string;
}

/**
 * One article, laid out to be read: the headline, a line of source and time,
 * the tickers it names as chips, a lead set larger than the body, the facts
 * that carry its figures, then the text at a reading measure with air between
 * paragraphs. A long article shows about a screen and keeps the rest behind
 * Read more.
 *
 * Keys while focused: j/k and the arrows scroll a line, space and Shift+space
 * a page, `]` and `[` jump between sections (paragraphs when there are none),
 * and n/p move to the next or previous article when the pane passes them.
 */
export function ArticleReader(props: ArticleReaderProps) {
  return <ArticleReaderView key={props.articleKey} {...props} />;
}

type Segment = { text: string; marked?: boolean; figure?: boolean };

function figureSegments(text: string): Segment[] {
  return splitFigures(text).map((run) => ({ text: run.text, figure: run.figure }));
}

interface ReaderGeometry {
  desktop: boolean;
  /** Desktop: the reading size, in em of the app's size. */
  fontEm: number;
  /** Terminal: characters per line. Desktop: an estimate, for deciding what Read more hides. */
  measure: number;
  /** Terminal only: columns left of the text column, which is centred in the pane. */
  margin: number;
}

function readerGeometry(width: number, desktop: boolean): ReaderGeometry {
  if (desktop) {
    const fontEm = width < DESKTOP_NARROW_CELLS ? DESKTOP_NARROW_FONT_EM : DESKTOP_FONT_EM;
    // A monospace glyph is about 0.6em wide; the column is inset 24px a side.
    const columnPx = Math.max(160, width * 8 - 48);
    return { desktop, fontEm, measure: Math.max(24, Math.min(DESKTOP_MEASURE_CH, Math.floor(columnPx / (fontEm * 12 * 0.6)))), margin: 0 };
  }
  // The scrollbar holds the last column.
  const usable = Math.max(12, Math.floor(width) - 1);
  const measure = Math.min(TERMINAL_MEASURE, Math.max(10, usable - 4));
  return { desktop, fontEm: 1, measure, margin: Math.max(2, Math.floor((usable - measure) / 2)) };
}

/** Rows of the app's 18px grid a desktop reading line takes, at the default size. */
function rowsPerLine(geometry: ReaderGeometry): number {
  return geometry.desktop ? (geometry.fontEm * DESKTOP_LINE_HEIGHT * 12) / 18 : 1;
}

function textRows(text: string, measure: number, geometry: ReaderGeometry): number {
  return wrapTextLines(text, measure).length * rowsPerLine(geometry);
}

function blockRows(block: ArticleBlock, geometry: ReaderGeometry): number {
  const { measure } = geometry;
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return textRows(block.text, measure, geometry) + 1;
    case "list":
      return block.items.reduce((sum, item) => sum + textRows(item, measure - 2, geometry), 0) + 1;
    case "table":
      return block.rows.length * (geometry.desktop ? 1.4 : 1) + 1;
  }
}

/**
 * How many body blocks fit in about a screen under the header, lead and
 * facts, or null when the whole article should show: it fits, or what would
 * be hidden is too short to be worth a click.
 */
function visibleBlockCount(
  body: readonly ArticleBlock[],
  aboveRows: number,
  height: number,
  geometry: ReaderGeometry,
): number | null {
  let used = aboveRows;
  let cut: number | null = null;
  for (const [index, block] of body.entries()) {
    used += blockRows(block, geometry);
    // At least one block of the body shows, whatever the header took.
    if (used > height && index >= 1) {
      cut = index;
      break;
    }
  }
  if (cut === null) return null;
  const hiddenWords = body.slice(cut).reduce((sum, block) => sum + blockWords(block), 0);
  return hiddenWords >= COLLAPSE_MIN_HIDDEN_WORDS ? cut : null;
}

/** A section label in the kit's casing: title case in English, a translation as it is written. */
function readerLabel(label: string): string {
  const translated = t(label);
  return translated === label ? titleCase(label) : translated;
}

/** Minutes the rest takes to read, at an unhurried 220 words a minute. */
function readingMinutes(blocks: readonly ArticleBlock[]): number {
  return Math.max(1, Math.round(blocks.reduce((sum, block) => sum + blockWords(block), 0) / 220));
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

function ArticleReaderView({
  title,
  meta,
  tickers = [],
  lead,
  facts = [],
  body,
  rawText,
  highlight,
  revealSection,
  focused,
  width,
  height,
  onNext,
  onPrevious,
  children,
  childrenLabel,
}: ArticleReaderProps) {
  const colors = useThemeColors();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const nativeRenderer = useNativeRenderer();
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const idPrefix = `reader-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const geometry = useMemo(() => readerGeometry(width, desktop), [desktop, width]);
  const shownTickers = useMemo(() => [...new Set(tickers)].slice(0, MAX_TICKERS), [tickers]);
  const metaText = meta.map((part) => part?.trim()).filter((part): part is string => !!part).join(" \u00b7 ");

  const aboveRows = useMemo(() => {
    const headline = title ? textRows(title, geometry.measure, geometry) * (geometry.desktop ? 1.3 : 1) : 0;
    const leadRows = lead ? textRows(lead, geometry.measure, geometry) * (geometry.desktop ? 1.1 : 1) + 1 : 0;
    const factRows = facts.length > 0
      ? facts.reduce((sum, fact) => sum + textRows(fact, geometry.measure - 2, geometry), 0) + 2
      : 0;
    return 2 + headline + 1 + (shownTickers.length > 0 ? 1 : 0) + 1 + leadRows + factRows;
  }, [facts, geometry, lead, shownTickers.length, title]);
  const collapseAt = useMemo(
    () => visibleBlockCount(body, aboveRows, Math.max(12, height), geometry),
    [aboveRows, body, geometry, height],
  );
  const revealIndex = revealSection == null ? -1 : body.findIndex((block) => block.section === revealSection);
  // A search that matched further down lands on the match, so that part is shown from the start.
  const [expanded, setExpanded] = useState(() => collapseAt === null || (revealIndex > 0 && revealIndex >= collapseAt));
  const [raw, setRaw] = useState(false);
  const visibleBody = expanded || collapseAt === null ? body : body.slice(0, collapseAt);
  const hiddenCount = body.length - visibleBody.length;

  const blockId = useCallback((index: number) => `${idPrefix}-b${index}`, [idPrefix]);

  /** Where block `index` starts, as an offset into the scrolled content, in the host's own units. */
  const blockTop = useCallback((index: number): { top: number; pixels: boolean } | null => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) return null;
    const id = blockId(index);
    if (desktop) {
      const node = (globalThis as { document?: { getElementById(id: string): { getBoundingClientRect(): { y: number } } | null } })
        .document?.getElementById(id);
      const box = scrollBox.getBoundingClientRect?.();
      if (!node || !box || typeof scrollBox.scrollTopPx !== "number") return null;
      return { top: scrollBox.scrollTopPx + node.getBoundingClientRect().y - box.y, pixels: true };
    }
    const node = scrollBox.content?.findDescendantById?.(id);
    const viewportY = scrollBox.viewport?.y;
    if (!node || typeof viewportY !== "number") return null;
    return { top: scrollBox.scrollTop + node.y - viewportY, pixels: false };
  }, [blockId, desktop]);

  const scrollToBlock = useCallback((index: number) => {
    const scrollBox = scrollRef.current;
    const target = blockTop(index);
    if (!scrollBox || !target) return;
    if (target.pixels) scrollBox.scrollToPixels?.(Math.max(0, target.top - 12));
    else scrollBox.scrollTo(Math.max(0, target.top - 1));
  }, [blockTop]);

  // Land on the section a search matched, once the host has laid it out.
  useEffect(() => {
    if (revealIndex <= 0) return;
    if (desktop) {
      const timer = setTimeout(() => scrollToBlock(revealIndex), 0);
      return () => clearTimeout(timer);
    }
    const onFrame = () => {
      nativeRenderer.off("frame", onFrame);
      scrollToBlock(revealIndex);
    };
    nativeRenderer.on("frame", onFrame);
    nativeRenderer.requestRender();
    return () => nativeRenderer.off("frame", onFrame);
    // Only on open: the reader is keyed by the article, so a new one mounts afresh.
  }, []);

  const blocks = raw ? NO_BLOCKS : visibleBody;

  /** Section starts to jump between: headings when the text has some, otherwise every block. */
  const jumpTargets = useMemo(() => {
    const headings = blocks.flatMap((block, index) => (block.kind === "heading" ? [index] : []));
    return headings.length >= 2 ? headings : blocks.map((_, index) => index);
  }, [blocks]);

  const jump = useCallback((direction: 1 | -1) => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) return;
    const current = desktop ? scrollBox.scrollTopPx ?? 0 : scrollBox.scrollTop;
    const slack = desktop ? 16 : 1;
    const tops = jumpTargets.map((index) => ({ index, top: blockTop(index)?.top ?? null }));
    if (direction > 0) {
      const next = tops.find((entry) => entry.top !== null && entry.top > current + slack);
      if (next) scrollToBlock(next.index);
      else if (hiddenCount > 0) setExpanded(true);
      return;
    }
    const previous = [...tops].reverse().find((entry) => entry.top !== null && entry.top < current - slack);
    if (previous) scrollToBlock(previous.index);
    else if (desktop) scrollBox.scrollToPixels?.(0);
    else scrollBox.scrollTo(0);
  }, [blockTop, desktop, hiddenCount, jumpTargets, scrollToBlock]);

  const page = useCallback((direction: 1 | -1) => {
    const scrollBox = scrollRef.current;
    if (!scrollBox) return;
    const rows = Math.max(1, (scrollBox.viewport?.height ?? height) - 2);
    const before = scrollBox.scrollTop;
    scrollByLines(scrollBox, direction * rows);
    // Paging past the end of a shortened article opens the rest.
    if (direction > 0 && scrollBox.scrollTop === before && hiddenCount > 0) setExpanded(true);
  }, [height, hiddenCount]);

  useShortcut((event) => {
    if (event.defaultPrevented || event.targetEditable) return;
    let handled = true;
    const line = isPlainKey(event, "j", "down") ? 1 : isPlainKey(event, "k", "up") ? -1 : 0;
    if (line && scrollRef.current) scrollByLines(scrollRef.current, line);
    else if (event.name === "space" && !event.ctrl && !event.meta && !event.alt) page(event.shift ? -1 : 1);
    else if (isPlainKey(event, "]")) jump(1);
    else if (isPlainKey(event, "[")) jump(-1);
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  }, { enabled: focused });

  const hints = useMemo<PaneHint[]>(() => [
    ...(onNext !== undefined ? [{ id: "reader-next", key: "n", label: "ext", title: "Next Article", disabled: !onNext, onPress: () => onNext?.() }] : []),
    ...(onPrevious !== undefined ? [{ id: "reader-previous", key: "p", label: "rev", title: "Previous Article", disabled: !onPrevious, onPress: () => onPrevious?.() }] : []),
  ], [onNext, onPrevious]);
  usePaneFooter("article-reader", () => ({ order: -2, hints }), [hints]);
  usePaneMenuItems("article-reader:menu", () => [
    { id: "reader-section-next", label: "Next Section", accelerator: "]", onSelect: () => jump(1) },
    { id: "reader-section-previous", label: "Previous Section", accelerator: "[", onSelect: () => jump(-1) },
    ...(collapseAt !== null && !raw
      ? [{ id: "reader-more", label: expanded ? "Show Less" : "Read More", onSelect: () => setExpanded((value) => !value) }]
      : []),
    ...(rawText?.trim()
      ? [{ id: "reader-raw", label: raw ? "Show Reader View" : "Show Original Text", onSelect: () => setRaw((value) => !value) }]
      : []),
  ], [collapseAt, expanded, jump, raw, rawText]);

  const header = (
    <Box flexDirection="column" style={desktop ? { marginBottom: "1.1em" } : undefined}>
      {title ? <ReaderText text={title} geometry={geometry} color={colors.textBright} bold variant="headline" /> : null}
      {metaText ? (
        <Box style={desktop && title ? { marginTop: "0.45em" } : undefined}>
          <ReaderText text={metaText} geometry={geometry} color={colors.textDim} variant="meta" />
        </Box>
      ) : null}
      {shownTickers.length > 0 ? (
        <Box style={desktop ? { marginTop: "0.6em", fontSize: `${1 / geometry.fontEm}em`, lineHeight: "normal" } : undefined}>
          <TickerBadgeList symbols={shownTickers} width={desktop ? Math.max(20, width - 8) : geometry.measure} />
        </Box>
      ) : null}
    </Box>
  );

  const content = (
    <Box flexDirection="column" gap={desktop ? undefined : 1}>
      {header}
      {!raw && lead ? (
        <ReaderText text={lead} geometry={geometry} color={colors.textBright} variant="lead" />
      ) : null}
      {!raw && facts.length > 0 ? (
        <Box flexDirection="column" style={desktop ? { margin: "0.3em 0 1.3em" } : undefined}>
          <ReaderText text={readerLabel("Key facts")} geometry={geometry} color={colors.textDim} variant="label" />
          {facts.map((fact, index) => (
            <ReaderText key={index} text={fact} geometry={geometry} color={colors.text} variant="fact" segments={figureSegments(fact)} figureColor={colors.textBright} />
          ))}
        </Box>
      ) : null}
      {raw ? <RawText text={rawText ?? ""} geometry={geometry} /> : null}
      {blocks.map((block, index) => (
        <Box key={index} id={blockId(index)} flexDirection="column">
          <ReaderBlock
            block={block}
            geometry={geometry}
            segments={highlight && block.section === highlight.section && block.kind === "paragraph" ? markTerms(block.text, highlight.terms) : undefined}
          />
        </Box>
      ))}
      {!raw && hiddenCount > 0 ? (
        <Box style={desktop ? { fontSize: `${1 / geometry.fontEm}em`, lineHeight: "normal", marginTop: "0.4em" } : undefined}>
          <ActionRow label="Read more" expanded={false} onPress={() => setExpanded(true)}>
            <Text fg={colors.textDim}>{`${readingMinutes(body.slice(visibleBody.length))} min`}</Text>
          </ActionRow>
        </Box>
      ) : null}
      {children ? (
        <Box flexDirection="column" style={desktop ? { marginTop: lead || blocks.length > 0 ? "0.8em" : 0 } : undefined}>
          {childrenLabel ? <ReaderText text={readerLabel(childrenLabel)} geometry={geometry} color={colors.textDim} variant="label" /> : null}
          <Box flexDirection="column" style={desktop ? { fontSize: `${1 / geometry.fontEm}em`, lineHeight: "normal" } : undefined}>
            {children}
          </Box>
        </Box>
      ) : null}
    </Box>
  );

  return (
    <ScrollBox ref={scrollRef} scrollY flexGrow={1} flexBasis={0} minHeight={0} focusable={false}>
      {desktop ? (
        <Box flexDirection="column" width="100%" alignItems="center" data-gloom-ui="article-reader">
          <Box
            flexDirection="column"
            width="100%"
            style={{
              // The measure plus the column's own inset on both sides.
              maxWidth: `calc(${DESKTOP_MEASURE_CH}ch + 48px)`,
              fontSize: `${geometry.fontEm}em`,
              lineHeight: DESKTOP_LINE_HEIGHT,
              padding: "1.2em 24px 3em",
              boxSizing: "border-box",
            }}
          >
            {content}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={geometry.margin} paddingY={1} width={geometry.margin + geometry.measure}>
          {content}
        </Box>
      )}
    </ScrollBox>
  );
}

/**
 * The text as indexed, line for line and with its spacing, for when the
 * reader view got something wrong. Only lines too long for the column wrap.
 */
function RawText({ text, geometry }: { text: string; geometry: ReaderGeometry }) {
  const colors = useThemeColors();
  if (geometry.desktop) {
    return (
      <Text fg={colors.text} wrapText width="100%" style={{ display: "block", whiteSpace: "pre-wrap", fontSize: "0.85em", lineHeight: 1.6 }}>
        {text}
      </Text>
    );
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => (
    displayWidth(line) <= geometry.measure ? [line] : wrapTextLines(line, geometry.measure)
  ));
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={index} height={1}>
          <Text fg={colors.text}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

type TextVariant = "headline" | "meta" | "lead" | "body" | "heading" | "label" | "fact" | "item";

const DESKTOP_VARIANT_STYLE: Record<TextVariant, Record<string, string | number>> = {
  headline: { fontSize: "1.45em", lineHeight: 1.22, letterSpacing: "-0.01em" },
  meta: { fontSize: "0.78em", lineHeight: 1.5 },
  lead: { fontSize: "1.1em", lineHeight: 1.55, marginBottom: "1.1em" },
  body: { lineHeight: DESKTOP_LINE_HEIGHT, marginBottom: "0.9em" },
  heading: { fontSize: "1.08em", lineHeight: 1.35, margin: "0.6em 0 0.35em" },
  label: { fontSize: "0.8em", lineHeight: 1.6, marginBottom: "0.3em" },
  fact: { fontSize: "0.95em", lineHeight: 1.55, marginBottom: "0.35em" },
  item: { lineHeight: 1.6, marginBottom: "0.3em" },
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
function ReaderText({
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
        width="100%"
        style={{ display: "block", ...DESKTOP_VARIANT_STYLE[variant], ...(bullet ? { marginBottom: 0 } : {}) }}
        content={content}
      >
        {content ? undefined : text}
      </Text>
    );
    if (!bullet) return textNode;
    return (
      <Box flexDirection="row" width="100%" style={{ marginBottom: DESKTOP_VARIANT_STYLE[variant].marginBottom }}>
        <Text fg={colors.textDim} style={{ fontSize: DESKTOP_VARIANT_STYLE[variant].fontSize, lineHeight: DESKTOP_VARIANT_STYLE[variant].lineHeight, width: "1.3em", flexShrink: 0 }}>{"\u2022"}</Text>
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

function ReaderBlock({
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
        <Box flexDirection="column" style={geometry.desktop ? { marginBottom: "0.9em" } : undefined}>
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
      <Box flexDirection="column" width="100%" style={{ overflowX: "auto", margin: "0.2em 0 1.3em", fontSize: `${1 / geometry.fontEm}em`, lineHeight: 1.9 }}>
        {lines.map((line, index) => (
          <Text
            key={index}
            fg={index === 0 && header ? colors.textDim : colors.text}
            attributes={index === 0 && header ? TextAttributes.BOLD : TextAttributes.NONE}
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

