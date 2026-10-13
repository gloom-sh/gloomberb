import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShortcut } from "../../react/input";
import { scrollByLines } from "../../state/pane-scroll-registry";
import { useThemeColors } from "../../theme/theme-context";
import {
  Box,
  ScrollBox,
  Text,
  useNativeRenderer,
  useUiCapabilities,
  type ScrollBoxRenderable,
} from "../../ui";
import { t } from "../../i18n";
import { isPlainKey } from "../../utils/keyboard";
import { displayWidth } from "../../utils/format";
import { wrapTextLines } from "../../utils/text-wrap";
import { usePaneFooter, usePaneMenuItems, type PaneHint } from "../layout/pane/footer";
import { TickerBadgeList } from "../ticker/badge/list";
import { ActionRow } from "../ui/action-row";
import { titleCase } from "../ui/header-case";
import { blockWords, markTerms, type ArticleBlock } from "./article-text";
import {
  READER_APP_FONT,
  READER_COLUMN_FONT,
  DESKTOP_LINE_HEIGHT,
  ReaderBlock,
  ReaderText,
  figureSegments,
  type ReaderGeometry,
} from "./reader-text";

/**
 * The longest line the reader sets, in characters. Past about 70 the eye
 * loses its place on the way back to the start of the next line.
 */
const TERMINAL_MEASURE = 72;
const DESKTOP_MEASURE_CH = 66;
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

/** The desktop sets its type and wraps in CSS; the browser lays the column out. */
const DESKTOP_GEOMETRY: ReaderGeometry = { desktop: true, measure: 0, margin: 0 };

function terminalGeometry(width: number): ReaderGeometry {
  // The scrollbar holds the last column.
  const usable = Math.max(12, Math.floor(width) - 1);
  const measure = Math.min(TERMINAL_MEASURE, Math.max(10, usable - 4));
  return { desktop: false, measure, margin: Math.max(2, Math.floor((usable - measure) / 2)) };
}

function textRows(text: string, measure: number): number {
  return wrapTextLines(text, measure).length;
}

function blockRows(block: ArticleBlock, measure: number): number {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return textRows(block.text, measure) + 1;
    case "list":
      return block.items.reduce((sum, item) => sum + textRows(item, measure - 2), 0) + 1;
    case "table":
      return block.rows.length + 1;
  }
}

/** Null when what would be hidden from `cut` on is too short to be worth a click. */
function collapseWorthIt(body: readonly ArticleBlock[], cut: number | null): number | null {
  if (cut === null) return null;
  const hiddenWords = body.slice(cut).reduce((sum, block) => sum + blockWords(block), 0);
  return hiddenWords >= COLLAPSE_MIN_HIDDEN_WORDS ? cut : null;
}

/**
 * Terminal: how many body blocks fit in about a screen under the header, lead
 * and facts, counted in rows, or null when the whole article should show.
 */
function visibleBlockCount(
  body: readonly ArticleBlock[],
  aboveRows: number,
  height: number,
  measure: number,
): number | null {
  let used = aboveRows;
  let cut: number | null = null;
  for (const [index, block] of body.entries()) {
    used += blockRows(block, measure);
    // At least one block of the body shows, whatever the header took.
    if (used > height && index >= 1) {
      cut = index;
      break;
    }
  }
  return collapseWorthIt(body, cut);
}

type DomNode = { getBoundingClientRect(): { bottom: number } };

/**
 * Desktop: the first body block that ends below the reader's viewport, read
 * from the laid-out page in pixels, or null when the whole article shows.
 */
function measuredBlockCount(
  body: readonly ArticleBlock[],
  viewport: { y: number; height: number } | undefined,
  blockNode: (index: number) => DomNode | null,
): number | null {
  if (!viewport || viewport.height <= 0) return null;
  let cut: number | null = null;
  for (let index = 1; index < body.length; index += 1) {
    const node = blockNode(index);
    if (!node) return null;
    if (node.getBoundingClientRect().bottom > viewport.y + viewport.height) {
      cut = index;
      break;
    }
  }
  return collapseWorthIt(body, cut);
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
  const geometry = useMemo(() => (desktop ? DESKTOP_GEOMETRY : terminalGeometry(width)), [desktop, width]);
  const shownTickers = useMemo(() => [...new Set(tickers)].slice(0, MAX_TICKERS), [tickers]);
  const metaText = meta.map((part) => part?.trim()).filter((part): part is string => !!part).join(" \u00b7 ");

  // The terminal counts rows at its measure; the desktop measures the laid-out page below.
  const aboveRows = useMemo(() => {
    if (desktop) return 0;
    const headline = title ? textRows(title, geometry.measure) : 0;
    const leadRows = lead ? textRows(lead, geometry.measure) + 1 : 0;
    const factRows = facts.length > 0
      ? facts.reduce((sum, fact) => sum + textRows(fact, geometry.measure - 2), 0) + 2
      : 0;
    return 2 + headline + 1 + (shownTickers.length > 0 ? 1 : 0) + 1 + leadRows + factRows;
  }, [desktop, facts, geometry, lead, shownTickers.length, title]);
  const terminalCollapseAt = useMemo(
    () => (desktop ? null : visibleBlockCount(body, aboveRows, Math.max(12, height), geometry.measure)),
    [aboveRows, body, desktop, geometry, height],
  );
  // Undefined until the desktop page is laid out and measured, before it paints.
  const [measuredCollapseAt, setMeasuredCollapseAt] = useState<number | null | undefined>(undefined);
  const collapseAt = desktop ? measuredCollapseAt ?? null : terminalCollapseAt;
  const revealIndex = revealSection == null ? -1 : body.findIndex((block) => block.section === revealSection);
  // A search that matched further down lands on the match, so that part is shown from the start.
  const [expanded, setExpanded] = useState(() => !desktop && (collapseAt === null || (revealIndex > 0 && revealIndex >= collapseAt)));
  const [raw, setRaw] = useState(false);
  const visibleBody = expanded || collapseAt === null ? body : body.slice(0, collapseAt);
  const hiddenCount = body.length - visibleBody.length;

  const blockId = useCallback((index: number) => `${idPrefix}-b${index}`, [idPrefix]);

  // Desktop: lay the whole article out once, then keep about a screen of it
  // by where its blocks actually end, before the first paint.
  useLayoutEffect(() => {
    if (!desktop || measuredCollapseAt !== undefined) return;
    const documentRef = (globalThis as { document?: { getElementById(id: string): DomNode | null } }).document;
    const cut = measuredBlockCount(
      body,
      scrollRef.current?.getBoundingClientRect?.(),
      (index) => documentRef?.getElementById(blockId(index)) ?? null,
    );
    setMeasuredCollapseAt(cut);
    if (cut === null || (revealIndex > 0 && revealIndex >= cut)) setExpanded(true);
  }, [blockId, body, desktop, measuredCollapseAt, revealIndex]);

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
        <Box style={desktop ? { marginTop: "0.6em", fontSize: READER_APP_FONT, lineHeight: "normal" } : undefined}>
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
        <Box style={desktop ? { fontSize: READER_APP_FONT, lineHeight: "normal", marginTop: "0.4em" } : undefined}>
          <ActionRow label="Read more" expanded={false} onPress={() => setExpanded(true)}>
            <Text fg={colors.textDim}>{`${readingMinutes(body.slice(visibleBody.length))} min`}</Text>
          </ActionRow>
        </Box>
      ) : null}
      {children ? (
        <Box flexDirection="column" style={desktop ? { marginTop: lead || blocks.length > 0 ? "0.8em" : 0 } : undefined}>
          {childrenLabel ? <ReaderText text={readerLabel(childrenLabel)} geometry={geometry} color={colors.textDim} variant="label" /> : null}
          <Box flexDirection="column" style={desktop ? { fontSize: READER_APP_FONT, lineHeight: "normal" } : undefined}>
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
            data-gloom-ui="reader-column"
            style={{
              // The measure plus the column's own inset on both sides.
              maxWidth: `calc(${DESKTOP_MEASURE_CH}ch + 48px)`,
              fontSize: READER_COLUMN_FONT,
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
      <Text fg={colors.text} wrapText selectable width="100%" style={{ display: "block", whiteSpace: "pre-wrap", fontSize: "0.85em", lineHeight: 1.6 }}>
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
