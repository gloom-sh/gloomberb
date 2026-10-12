import { useCallback, useMemo, useRef } from "react";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePagedRows,
  usePaneStatusLinkFooter,
  useTableLoadMore,
  type DataTableCell,
  type PaneFooterSegment,
  type QueryBarFilter,
} from "../../../../../components";
import { usePaneRefreshKey } from "../../../../../components/data-table/table-pane";
import type { Letter } from "../../../../../api-client/letters";
import { usePluginPaneState } from "../../../../../public/react";
import { useRemoteUiNode } from "../../../../../remote/semantic-tree";
import { colors } from "../../../../../theme/colors";
import { Box, useRendererHost, type ScrollBoxRenderable } from "../../../../../ui";
import { letterPageLoader } from "./client";
import {
  BASIS_COLUMN_MIN_WIDTH,
  DEFAULT_KIND_VIEW,
  LETTER_KIND_OPTIONS,
  LETTER_KIND_VIEWS,
  letterColumns,
  letterDateBasisLabel,
  letterKindLabel,
  letterKindView,
  type LetterColumn,
} from "./model";

const LETTERS_FOOTER_ID = "news-industry:letters";
/** What a report or capture of NI LTR says it lists, in place of NI's "published stories". */
const LETTERS_REPORT_BASIS = "public letters";

/**
 * The Letters code of Topic News: public fund and investor letters as links.
 * Each row names the date, who wrote it, the title and the kind; Enter or a
 * click opens the publisher's own page. It reads an anonymous route, so it
 * works signed out.
 */
export function LettersBody({ focused, width, height, codeFilter }: {
  focused: boolean;
  width: number;
  height: number;
  /** Topic News's own code picker, so the user can leave this code. */
  codeFilter: QueryBarFilter;
}) {
  const rendererHost = useRendererHost();
  // Saved by name; an older build's "all" or anything unknown reads as the default view.
  const [savedView, setKind] = usePluginPaneState<string>("industry:letters:kind", DEFAULT_KIND_VIEW);
  const view = letterKindView(savedView);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("industry:letters:selected", null);
  // One loader per view, so a change of view starts the list and its offsets over.
  const loadPage = useMemo(() => letterPageLoader(LETTER_KIND_VIEWS[view].kinds), [view]);
  const letters = usePagedRows(loadPage, { getId: (letter) => letter.id });
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(scrollRef, letters.hasMore, letters.loadMore);
  const rows = letters.rows;
  const selected = rows.find((letter) => letter.id === selectedId) ?? rows[0] ?? null;
  const columns = useMemo(() => letterColumns(width), [width]);
  const open = useCallback((letter: Letter) => { void rendererHost.openExternal(letter.url); }, [rendererHost]);
  usePaneRefreshKey(letters.reload, { focused });
  // A report or capture of this code lists letters, not news stories.
  useRemoteUiNode({
    role: "report-freshness",
    label: "Letters freshness",
    getMetadata: () => ({ status: "not-a-feed", basis: LETTERS_REPORT_BASIS }),
  });

  const loading = letters.loading && rows.length === 0;
  const error = letters.error?.message ?? null;
  // Too narrow for the Date basis column: the footer says what the selected row's date is.
  const basisInFooter = width < BASIS_COLUMN_MIN_WIDTH && selected ? letterDateBasisLabel(selected).toLowerCase() : null;
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(basisInFooter ? [{ id: "date-basis", parts: [{ text: basisInFooter, tone: "muted" as const }] }] : []),
    ...(letters.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
    ...(letters.moreError ? [{ id: "more-error", parts: [{ text: letters.moreError.message, tone: "warning" as const }] }] : []),
  ], [basisInFooter, letters.loadingMore, letters.moreError]);
  usePaneStatusLinkFooter({
    registrationId: LETTERS_FOOTER_ID,
    focused,
    url: selected?.url,
    label: "letter",
    loading: letters.loading,
    error: rows.length > 0 ? error : null,
    info,
    showOpenHint: !!selected,
  });

  const kindFilter: QueryBarFilter = {
    id: "kind",
    label: "Kind",
    title: "Kind",
    value: view,
    defaultValue: DEFAULT_KIND_VIEW,
    options: LETTER_KIND_OPTIONS,
    onChange: (value) => {
      setKind(value);
      setSelectedId(null);
    },
  };
  const bar = <QueryBar width={width} filters={[codeFilter, kindFilter]} />;

  const renderCell = useCallback((letter: Letter, column: LetterColumn): DataTableCell => {
    switch (column.id) {
      case "date":
        // A file's last change is the weaker date: muted, as Distress mutes a first-seen date.
        return { text: letter.date, value: letter.date, color: letter.date_basis === "file_modified" ? colors.textMuted : colors.text };
      case "basis":
        return { text: letterDateBasisLabel(letter), color: colors.textMuted };
      case "entity":
        return { text: letter.entity, color: colors.text };
      case "title":
        return { text: letter.title, color: colors.textBright };
      case "kind":
        return { text: letterKindLabel(letter), color: colors.textDim };
    }
  }, []);

  if (loading || (error && rows.length === 0)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {bar}
        <PaneStatusBody loading={loading} error={error} subject="letters" errorTitle="Letters unavailable." />
      </Box>
    );
  }

  return (
    <DataTableView<Letter, LetterColumn>
      focused={focused}
      rootBefore={bar}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      getItemKey={(letter) => letter.id}
      renderCell={renderCell}
      selection={{
        kind: "id",
        selectedId: selected?.id ?? null,
        getId: (letter) => letter.id,
        onChange: setSelectedId,
      }}
      onActivate={open}
      sortColumnId={null}
      sortDirection="desc"
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
      selectedTextOverridesCellColor
      emptyStateTitle="No letters yet"
    />
  );
}
