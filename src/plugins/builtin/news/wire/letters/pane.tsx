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
import { colors } from "../../../../../theme/colors";
import { Box, useRendererHost, type ScrollBoxRenderable } from "../../../../../ui";
import { letterPageLoader } from "./client";
import {
  ALL_KINDS,
  LETTER_KIND_OPTIONS,
  letterColumns,
  letterKindFilter,
  letterKindLabel,
  type LetterColumn,
} from "./model";

const LETTERS_FOOTER_ID = "news-industry:letters";

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
  const [kindValue, setKind] = usePluginPaneState<string>("industry:letters:kind", ALL_KINDS);
  const kind = letterKindFilter(kindValue);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("industry:letters:selected", null);
  const loadPage = useMemo(() => letterPageLoader(kind), [kind]);
  const letters = usePagedRows(loadPage, { getId: (letter) => letter.id });
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMore = useTableLoadMore(scrollRef, letters.hasMore, letters.loadMore);
  const rows = letters.rows;
  const selected = rows.find((letter) => letter.id === selectedId) ?? rows[0] ?? null;
  const columns = useMemo(() => letterColumns(width), [width]);
  const open = useCallback((letter: Letter) => { void rendererHost.openExternal(letter.url); }, [rendererHost]);
  usePaneRefreshKey(letters.reload, { focused });

  const loading = letters.loading && rows.length === 0;
  const error = letters.error?.message ?? null;
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(letters.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
    ...(letters.moreError ? [{ id: "more-error", parts: [{ text: letters.moreError.message, tone: "warning" as const }] }] : []),
  ], [letters.loadingMore, letters.moreError]);
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
    value: kindValue,
    defaultValue: ALL_KINDS,
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
        return { text: letter.date, value: letter.date, color: colors.textMuted };
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
