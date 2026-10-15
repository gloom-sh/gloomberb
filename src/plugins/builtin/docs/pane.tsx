/**
 * DOCS: the gloom.sh docs and Academy lessons read inside the app. The index
 * is a searchable list of every function, docs page and lesson; opening one
 * reads it in the pane, links between them stay in the pane, and Back walks
 * the way back. The `?` on a pane and `DOCS <function>` open an entry on top
 * of wherever the reader is. The browser is one explicit key away (`o`).
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  ActionRow,
  Badge,
  buildSectionedRows,
  DataTableStackView,
  DetailScrollBody,
  EmptyState,
  EMPTY_TABLE_CELL,
  isSectionedItemRow,
  MarkdownText,
  PaneLinkMenu,
  PaneStatusBody,
  QueryBar,
  renderSectionedRowHeader,
  Button,
  usePaneFooter,
  usePaneLinkMenuEntry,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type PaneHint,
  type SectionedRow,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import type { DocsFeed, DocsFunction } from "../../../docs/content";
import {
  docsEntries,
  docsHrefUrl,
  docsPagesForFunction,
  docsTopicExists,
  docsTopicFromHref,
  docsTopicKey,
  docsTopicUrl,
  findDocsFunction,
  findDocsLesson,
  findDocsPage,
  parseDocsTopicKey,
  searchDocsEntries,
  type DocsEntry,
  type DocsTopic,
} from "../../../docs/topics";
import { t, tf } from "../../../i18n";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { usePaneInstance } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { badgeCell } from "../help/table-cells";
import { DESKTOP_LINE_HEIGHT, READER_COLUMN_FONT, READER_MEASURE } from "../../../components/reader/reader-text";
import { DocsBlocks } from "./blocks";
import { useDocsFeed, useDocsLesson } from "./use-docs";

type DocsShow = "all" | "functions" | "guides" | "academy";
type DocsColumn = DataTableColumn & { id: "code" | "title" | "about" };
type DocsRow = SectionedRow<DocsEntry>;

const SHOW_OPTIONS = [
  { value: "all", label: "All" },
  { value: "functions", label: "Functions" },
  { value: "guides", label: "Guides" },
  { value: "academy", label: "Academy" },
] as const;

/** How far Back reaches: every ? and DOCS lands on top of the reader's history. */
const STACK_LIMIT = 30;
/** Prose reads best at about seventy columns, however wide the pane. */
const MEASURE = 72;
/**
 * On the desktop and the web the text reads as in every reader
 * (reader-text.tsx): the body size, a step up from the table text, the
 * reading line height, centred at the measure; the column fills a narrower
 * pane and stops there in a wider one.
 */
export const DOCS_READING_STYLE = { fontSize: READER_COLUMN_FONT, "--cell-h": `${DESKTOP_LINE_HEIGHT}em`, maxWidth: READER_MEASURE, alignSelf: "center" } as const;
/** The terminal wraps at `width` columns; the desktop and the web at the reading column's own width. */
function useTextWidth(width: number): number | "100%" {
  return useUiCapabilities().nativePaneChrome ? "100%" : width;
}
/** Below this the description column folds away and the title takes the row. */
const ABOUT_COLUMN_MIN_WIDTH = 64;

function shows(show: DocsShow, entry: DocsEntry): boolean {
  if (show === "all") return true;
  if (show === "functions") return entry.topic.kind === "function";
  if (show === "guides") return entry.topic.kind === "page";
  return entry.topic.kind === "lesson";
}

function topicTitle(feed: DocsFeed | null, topic: DocsTopic): string {
  if (!feed) return "";
  switch (topic.kind) {
    case "function": {
      const fn = findDocsFunction(feed, topic.code);
      return fn ? `${fn.code} · ${fn.name}` : topic.code;
    }
    case "page": return findDocsPage(feed, topic.slug)?.title ?? topic.slug;
    case "lesson": return findDocsLesson(feed, topic.url)?.title ?? t("Academy");
    case "home": return "";
  }
}

/** A related entry: a row to click, and a pane menu item for the keyboard. */
function RelatedRow({ label, detail, topic, onOpenTopic, width }: {
  label: string;
  detail?: string;
  topic: DocsTopic;
  onOpenTopic: (topic: DocsTopic) => void;
  width: number;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  usePaneLinkMenuEntry(`docs-topic:${docsTopicKey(topic)}`, tf("Open {label}", { label }), () => onOpenTopic(topic));
  return (
    <ActionRow label={label} onPress={() => onOpenTopic(topic)} width={nativePaneChrome ? undefined : width}>
      {detail ? <Text fg={colors.textMuted}>{detail}</Text> : null}
    </ActionRow>
  );
}

function FunctionEntry({ fn, feed, width, onOpenTopic, onOpenLink }: {
  fn: DocsFunction;
  feed: DocsFeed;
  width: number;
  onOpenTopic: (topic: DocsTopic) => void;
  onOpenLink: (href: string) => void;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const textWidth = useTextWidth(width);
  const pages = docsPagesForFunction(feed, fn.code).slice(0, 3);
  const lesson = fn.lesson ? findDocsLesson(feed, fn.lesson) : null;
  const tag = fn.plugin ? tf("Plugin: {name}", { name: fn.plugin.name }) : fn.access === "pro" ? "Pro" : fn.access === "cloud" ? t("Gloom Cloud account") : null;
  return (
    <Box flexDirection="column" gap={1}>
      <Text fg={colors.textBright} wrapText width={textWidth}>{fn.description}</Text>
      {nativePaneChrome && fn.shot ? (
        <DocsBlocks blocks={[{ type: "image", src: fn.shot, alt: `${fn.code} ${fn.name}` }]} width={width} onOpenLink={onOpenLink} />
      ) : null}
      <Box flexDirection="row" gap={2}>
        <Text fg={colors.textMuted}>{t("Type")}</Text>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{fn.arg ? `${fn.code} ${fn.arg}` : fn.code}</Text>
        {tag ? <Badge label={tag} tone={fn.access === "pro" ? "accent" : "neutral"} /> : null}
      </Box>
      <MarkdownText text={fn.detail} lineWidth={width} onOpenLink={onOpenLink} />
      {(pages.length > 0 || lesson) && (
        <Box flexDirection="column">
          {pages.map((page) => (
            <RelatedRow key={page.slug} label={page.title} topic={{ kind: "page", slug: page.slug }} onOpenTopic={onOpenTopic} width={width} />
          ))}
          {lesson && (
            <RelatedRow
              label={tf("Academy: {title}", { title: lesson.title })}
              detail={lesson.minutes > 0 ? tf("{minutes} min", { minutes: lesson.minutes }) : undefined}
              topic={{ kind: "lesson", url: lesson.url }}
              onOpenTopic={onOpenTopic}
              width={width}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

function LessonEntry({ url, width, onOpenLink }: { url: string; width: number; onOpenLink: (href: string) => void }) {
  const colors = useThemeColors();
  const textWidth = useTextWidth(width);
  const lesson = useDocsLesson(url);
  if (lesson.status === "loading") return <PaneStatusBody loading subject="Lesson" align="start" />;
  if (lesson.status === "unavailable") {
    return (
      <EmptyState
        title="This lesson is not saved for offline reading."
        hint="It is kept once it has been read with a connection."
        retry={{ onRetry: lesson.retry }}
      />
    );
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text fg={colors.textMuted} wrapText width={textWidth}>
        {[lesson.lesson.chapter, lesson.lesson.minutes > 0 ? tf("{minutes} min", { minutes: lesson.lesson.minutes }) : ""].filter(Boolean).join(" · ")}
      </Text>
      {lesson.lesson.summary ? <Text fg={colors.textBright} wrapText width={textWidth}>{lesson.lesson.summary}</Text> : null}
      <DocsBlocks blocks={lesson.lesson.blocks} width={width} onOpenLink={onOpenLink} />
    </Box>
  );
}

function UnknownEntry({ topic, onSearch }: { topic: DocsTopic; onSearch: (query: string) => void }) {
  const query = topic.kind === "function" ? topic.code : topic.kind === "page" ? topic.slug.replace(/-/g, " ") : "";
  return (
    <EmptyState
      title={query ? tf("No docs for {name} yet.", { name: query }) : "No docs for this yet."}
      hint="Search the docs by name, or press F1 for its keys."
      actions={<Button label="Search the Docs" onPress={() => onSearch(query)} compact />}
    />
  );
}

function TopicView({ topic, feed, width, scrollRef, onOpenTopic, onOpenLink, onSearch }: {
  topic: DocsTopic;
  feed: DocsFeed;
  width: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onOpenTopic: (topic: DocsTopic) => void;
  onOpenLink: (href: string) => void;
  onSearch: (query: string) => void;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  // The detail body pads a cell each side and the scroll bar takes one more.
  const measure = Math.max(16, Math.min(width - 4, MEASURE));
  const body = (() => {
    if (topic.kind === "lesson") {
      return <LessonEntry url={topic.url} width={measure} onOpenLink={onOpenLink} />;
    }
    if (!docsTopicExists(feed, topic)) return <UnknownEntry topic={topic} onSearch={onSearch} />;
    if (topic.kind === "function") {
      const fn = findDocsFunction(feed, topic.code)!;
      return <FunctionEntry fn={fn} feed={feed} width={measure} onOpenTopic={onOpenTopic} onOpenLink={onOpenLink} />;
    }
    if (topic.kind === "page") {
      const page = findDocsPage(feed, topic.slug)!;
      return (
        <Box flexDirection="column" gap={1}>
          {page.lead ? <MarkdownText text={page.lead} lineWidth={measure} textColor={colors.textBright} onOpenLink={onOpenLink} /> : null}
          <DocsBlocks blocks={page.blocks} width={measure} onOpenLink={onOpenLink} />
        </Box>
      );
    }
    return null;
  })();
  return (
    <DetailScrollBody ref={scrollRef} resetScrollKey={docsTopicKey(topic)}>
      <PaneLinkMenu>
        <Box flexDirection="column" width={nativePaneChrome ? "100%" : measure} data-gloom-role="docs-body" style={nativePaneChrome ? DOCS_READING_STYLE : undefined}>
          {body}
        </Box>
      </PaneLinkMenu>
    </DetailScrollBody>
  );
}

export function DocsPane({ focused, width, height }: PaneProps) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const { openCommandBar } = usePluginAppActions();
  const instance = usePaneInstance();
  const requestKey = instance?.params?.topic ?? null;
  const requestAt = instance?.params?.at ?? null;
  const { feed, offline, reload } = useDocsFeed();
  usePaneRefreshKey(reload, { focused });
  const [stack, setStack] = usePluginPaneState<string[]>("stack", []);
  const [query, setQuery] = usePluginPaneState<string>("query", "");
  const [show, setShow] = usePluginPaneState<DocsShow>("show", "all");
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selected", null);
  const [handledAt, setHandledAt] = usePluginPaneState<string | null>("handledAt", null);
  const search = useQueryBarSearch();
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);

  const openTopic = useCallback((topic: DocsTopic) => {
    if (topic.kind === "home") {
      setStack([]);
      if (topic.query !== undefined) setQuery(topic.query);
      return;
    }
    const key = docsTopicKey(topic);
    setStack((current) => (current[current.length - 1] === key ? current : [...current, key].slice(-STACK_LIMIT)));
  }, [setQuery, setStack]);

  // A request from a pane's ? or DOCS <function> lands on top of the reader,
  // once: the pane keeps it in its params, so a restart must not replay it.
  useEffect(() => {
    if (!feed || !requestKey || !requestAt || requestAt === handledAt) return;
    setHandledAt(requestAt);
    const topic = parseDocsTopicKey(requestKey);
    if (!topic) return;
    if (topic.kind === "home" && topic.query && findDocsPage(feed, topic.query.toLowerCase())) {
      openTopic({ kind: "page", slug: topic.query.toLowerCase() });
      return;
    }
    // The command line cannot resolve a mnemonic before the reader runs, so a search that is a function's code opens its entry.
    const code = topic.kind === "home" && topic.query ? findDocsFunction(feed, topic.query.trim()) ?? findDocsFunction(feed, topic.query.trim().split(/\s+/)[0] ?? "") : null;
    if (code) {
      openTopic({ kind: "function", code: code.code });
      return;
    }
    if (topic.kind === "home") setShow("all");
    openTopic(topic);
  }, [feed, handledAt, openTopic, requestAt, requestKey, setHandledAt, setShow]);

  const topKey = stack[stack.length - 1] ?? null;
  const topic = topKey ? parseDocsTopicKey(topKey) : null;
  const back = useCallback(() => setStack((current) => current.slice(0, -1)), [setStack]);
  const searchFor = useCallback((next: string) => {
    setStack([]);
    setShow("all");
    setQuery(next);
  }, [setQuery, setShow, setStack]);

  const openLink = useCallback((href: string) => {
    const target = feed ? docsTopicFromHref(feed, href) : null;
    if (target) {
      openTopic(target);
      return;
    }
    // Anything that is not the docs leaves the app only when it is clicked.
    void rendererHost.openExternal(docsHrefUrl(href));
  }, [feed, openTopic, rendererHost]);

  const entries = useMemo(() => (feed ? docsEntries(feed) : []), [feed]);
  const rows = useMemo<DocsRow[]>(() => {
    const visible = searchDocsEntries(entries, query).filter((entry) => shows(show, entry));
    if (!query.trim()) {
      const sections = new Map<string, DocsEntry[]>();
      for (const entry of visible) sections.set(entry.section, [...(sections.get(entry.section) ?? []), entry]);
      return buildSectionedRows([...sections].map(([label, items]) => ({ label, items })), (entry) => entry.key);
    }
    // A search reads best by kind, each kind best match first.
    return buildSectionedRows([
      { label: "Functions", items: visible.filter((entry) => entry.topic.kind === "function") },
      { label: "Guides", items: visible.filter((entry) => entry.topic.kind === "page") },
      { label: "Academy", items: visible.filter((entry) => entry.topic.kind === "lesson") },
    ], (entry) => entry.key);
  }, [entries, query, show]);

  const visibleEntries = useMemo(() => rows.filter(isSectionedItemRow).map((row) => row.item), [rows]);
  // A request that matches nothing fails a report of the pane (`gloomberb fn DOCS zzzz`) instead of listing the whole index.
  const requested = requestKey ? parseDocsTopicKey(requestKey) : null;
  const requestedQuery = requested?.kind === "home" ? requested.query?.trim() ?? "" : "";
  useRemoteUiNode(feed && requestedQuery && stack.length === 0 && query.trim() === requestedQuery && visibleEntries.length === 0 ? {
    role: "report-failure",
    label: "No docs entry",
    getMetadata: () => ({ message: `No docs entry for ${requestedQuery}.`, details: "Run gloomberb fn DOCS for the index." }),
  } : null);
  const effectiveSelectedKey = visibleEntries.some((entry) => entry.key === selectedKey)
    ? selectedKey
    : visibleEntries[0]?.key ?? null;

  const showAbout = width >= ABOUT_COLUMN_MIN_WIDTH;
  const columns = useMemo<DocsColumn[]>(() => [
    { id: "code", label: "FN", width: 9, align: "left" },
    { id: "title", label: "Title", width: showAbout ? 30 : 24, align: "left", flexGrow: showAbout ? 0 : 1 },
    ...(showAbout ? [{ id: "about" as const, label: "About", width: 20, align: "left" as const, flexGrow: 1 }] : []),
  ], [showAbout]);

  const renderCell = useCallback((row: DocsRow, column: DocsColumn, _index: number, rowState: { selected: boolean }): DataTableCell => {
    if (!isSectionedItemRow(row)) return EMPTY_TABLE_CELL;
    const entry = row.item;
    if (column.id === "code") return entry.code ? badgeCell([entry.code], column.width) : EMPTY_TABLE_CELL;
    if (column.id === "title") return { text: entry.title, color: rowState.selected ? colors.selectedText : colors.textBright };
    return { text: entry.about, color: rowState.selected ? colors.selectedText : colors.textDim };
  }, [colors]);

  const openInBrowser = useCallback(() => {
    void rendererHost.openExternal(docsTopicUrl(topic ?? { kind: "home" }));
  }, [rendererHost, topic]);

  const footerInfo = useMemo<PaneFooterSegment[]>(() => (
    offline ? [{ id: "docs-offline", parts: [{ text: "offline, saved copy", tone: "warning" }] }] : []
  ), [offline]);
  const footerHints = useMemo<PaneHint[]>(() => {
    const hints: PaneHint[] = [];
    if (topic?.kind === "function" && feed && findDocsFunction(feed, topic.code)) {
      const code = topic.code;
      hints.push({ id: "docs-try", key: "t", label: "ry it", title: tf("Try {code}", { code }), onPress: () => openCommandBar(`${code} `) });
    }
    hints.push({ id: "docs-browser", key: "o", label: "pen in browser", title: "Open in Browser", onPress: openInBrowser });
    return hints;
  }, [feed, openCommandBar, openInBrowser, topic]);
  usePaneFooter("docs", () => ({ info: footerInfo, hints: footerHints }), [footerHints, footerInfo]);

  if (!feed) return <PaneStatusBody loading subject="Docs" />;

  return (
    <DataTableStackView<DocsRow, DocsColumn>
      focused={focused && !search.active}
      detailOpen={topic !== null}
      onBack={back}
      detailTitle={topic ? topicTitle(feed, topic) : undefined}
      detailContent={topic ? (
        <TopicView
          topic={topic}
          feed={feed}
          width={width}
          scrollRef={detailScrollRef}
          onOpenTopic={openTopic}
          onOpenLink={openLink}
          onSearch={searchFor}
        />
      ) : <Box flexGrow={1} />}
      detailScrollRef={detailScrollRef}
      rootWidth={width}
      rootHeight={height}
      rootBefore={(
        <QueryBar
          width={width}
          search={{
            value: query,
            onChange: setQuery,
            placeholder: "function, page or lesson",
            focused,
            ...search.searchProps,
          }}
          filters={[{
            id: "show",
            label: "Show",
            inline: true,
            value: show,
            defaultValue: "all",
            options: SHOW_OPTIONS,
            onChange: (value: DocsShow) => setShow(value),
          }]}
        />
      )}
      columns={columns}
      items={rows}
      selection={{
        kind: "id",
        selectedId: effectiveSelectedKey,
        getId: (row) => row.key,
        onChange: (_id, row) => {
          if (isSectionedItemRow(row)) setSelectedKey(row.item.key);
        },
      }}
      isNavigable={isSectionedItemRow}
      onActivate={(row) => {
        if (isSectionedItemRow(row)) openTopic(row.item.topic);
      }}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={(row) => row.key}
      renderSectionHeader={renderSectionedRowHeader}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      showHorizontalScrollbar={false}
      emptyStateTitle={query.trim() ? tf("No docs match \"{query}\".", { query: query.trim() }) : "No docs to show."}
    />
  );
}

