import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InsiderSignalRow } from "../../../api-client/insider-signals";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableCell,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { formatShortDate } from "../../../utils/datetime-format";
import { usePluginPaneState } from "../../runtime";
import { SignInWall } from "../cloud/auth-actions";
import { listingCell } from "../shared/research-cells";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedInsiderSignals, DEFAULT_INSIDER_SIGNAL_WINDOW, loadInsiderSignals } from "./signals-client";
import {
  buildInsiderSignalColumns,
  compareInsiderSignalRows,
  formatSignalDay,
  formatSignalValue,
  INSIDER_SIGNAL_WINDOW_OPTIONS,
  insiderSignalFirstDirection,
  insiderSignalsCoverageNotice,
  insiderSignalsEmptyTitle,
  insiderSignalWhy,
  insiderSignalWindow,
  type InsiderSignalColumn,
  type InsiderSignalColumnId,
} from "./signals-model";

interface InsiderSignalsViewProps {
  width: number;
  height: number;
  focused: boolean;
  /** Opens the company's insider transactions in this pane. */
  onOpen: (ticker: string) => void;
}

/**
 * INS without a ticker: the companies whose insiders bought shares in the
 * open market lately, ranked, each with why in plain words. Enter or a click
 * opens the company's own INS in the same pane.
 */
export function InsiderSignalsView({ width, height, focused, onOpen }: InsiderSignalsViewProps) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  const [storedWindow, setWindow] = usePluginPaneState<number>("insider:signals:window", DEFAULT_INSIDER_SIGNAL_WINDOW);
  const windowDays = insiderSignalWindow(storedWindow);
  const [selectedTicker, setSelectedTicker] = usePluginPaneState<string | null>("insider:signals:selected", null);
  const [sort, setSort] = useState<{ columnId: InsiderSignalColumnId; direction: "asc" | "desc" }>({ columnId: "score", direction: "desc" });

  const loader = useCallback((force: boolean) => loadInsiderSignals(windowDays, { force }), [windowDays]);
  const resource = useAsyncResource(loader, {
    initialData: () => cachedInsiderSignals(windowDays),
    clearOnError: (error) => error instanceof Error && isCloudSessionRequired(error.message),
    // Another window keeps the rows on screen, loading, until its own arrive.
    keepPreviousData: true,
  });
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  // Signing in or out reads the ranking again for the new session.
  const sessionKeyRef = useRef(session.requestKey);
  const reload = resource.reload;
  useEffect(() => {
    if (sessionKeyRef.current === session.requestKey) return;
    sessionKeyRef.current = session.requestKey;
    void reload();
  }, [reload, session.requestKey]);

  const data = resource.data?.payload ?? null;
  const rows = data?.rows ?? [];
  const sortedRows = useMemo(() => {
    const order = new Map(rows.map((row, index) => [row.ticker, index]));
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => (
      sign * compareInsiderSignalRows(a, b, sort.columnId) || order.get(a.ticker)! - order.get(b.ticker)!
    ));
  }, [rows, sort]);
  const columns = useMemo(() => buildInsiderSignalColumns(width, rows), [rows, width]);

  usePaneStatusFooter({
    registrationId: "insider:signals",
    loading: resource.loading,
    error: data ? resource.error : null,
    stale: !!data && !!resource.data?.stale,
    info: data?.asOf
      ? [{ id: "asof", asOf: true, parts: [{ text: `as of ${formatShortDate(data.asOf, { utc: true })}`, tone: "muted" as const }] }]
      : [],
  });
  const coverageNotice = data ? insiderSignalsCoverageNotice(data) : null;
  usePaneNoticeFooter({
    registrationId: "insider:signals:notices",
    focused,
    notices: [
      ...(coverageNotice ? [coverageNotice] : []),
      ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ],
  });

  const renderCell = useCallback((row: InsiderSignalRow, column: InsiderSignalColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    switch (column.id) {
      case "ticker": return listingCell(row.ticker, colors, state.selected);
      case "company": return { text: row.company, color: colors.textMuted };
      case "score": return { text: String(row.score), value: row.score, color: colors.textBright };
      case "why": return { text: insiderSignalWhy(row), color: colors.text };
      case "insiders": return { text: String(row.insiders), value: row.insiders, color: colors.text };
      // Every row is buying, drawn in the gain colour as INS draws a buy.
      case "value": return { text: formatSignalValue(row.value), value: row.value, color: colors.positive };
      case "lastBuy": return { text: formatSignalDay(row.lastBuy), value: row.lastBuy, color: colors.textDim };
    }
  }, [colors]);

  if (!data && isCloudSessionRequired(resource.error)) {
    return <SignInWall placement="insider-signals-signin" width={width} height={height} action="view insider buying" needsVerification={session.needsVerification} />;
  }

  return (
    <PaneStatusBody
      loading={!data && resource.loading}
      error={!data ? resource.error : null}
      retry={{ onRetry: () => void resource.reload(), pending: resource.loading }}
      subject="Insider buying"
    >
      {data ? (
        <DataTableView<InsiderSignalRow, InsiderSignalColumn>
          focused={focused}
          rootWidth={width}
          rootHeight={height}
          rootBefore={(
            <QueryBar
              width={width}
              filters={[{
                id: "window",
                label: "Window",
                title: "Days of buying to rank",
                value: String(windowDays),
                defaultValue: String(DEFAULT_INSIDER_SIGNAL_WINDOW),
                options: INSIDER_SIGNAL_WINDOW_OPTIONS,
                inline: true,
                onChange: (value: string) => setWindow(insiderSignalWindow(value)),
              }]}
            />
          )}
          columns={columns}
          items={sortedRows}
          getItemKey={(row) => row.ticker}
          selection={{
            kind: "id",
            selectedId: selectedTicker,
            getId: (row) => row.ticker,
            onChange: (ticker) => setSelectedTicker(ticker),
          }}
          onActivate={(row) => {
            onOpen(row.ticker);
            setSelectedTicker(row.ticker);
          }}
          sortColumnId={sort.columnId}
          sortDirection={sort.direction}
          onHeaderClick={(columnId) => setSort((current) => {
            const id = columnId as InsiderSignalColumnId;
            if (current.columnId !== id) return { columnId: id, direction: insiderSignalFirstDirection(id) };
            return { columnId: id, direction: current.direction === "asc" ? "desc" : "asc" };
          })}
          renderCell={renderCell}
          selectedTextOverridesCellColor
          showHorizontalScrollbar={false}
          emptyStateTitle={insiderSignalsEmptyTitle(data.window)}
        />
      ) : null}
    </PaneStatusBody>
  );
}
