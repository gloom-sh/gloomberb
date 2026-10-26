import { useCallback, useMemo, type ReactNode } from "react";
import type { ThemeMember, ThemePeriod, ThemeSummary } from "../../../api-client/themes";
import { splitDelayedStatus, DataTableStackView, DataTableView, PaneStatusBody, usePaneNoticeFooter, usePaneStatusFooter, type DataTableCell, type DataTableColumn } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import type { ExtendedSession } from "../../../market-data/market/status";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, usePluginTickerActions, useUpdatedAgo } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import { shownPriceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text } from "../../../ui";
import { nextHeaderSort } from "../../../utils/sort-values";
import { useMembersMenu } from "../shared/members-menu";
import { cachedMembers, cachedThemes, loadMembers, loadThemes } from "./client";
import {
  aggregateText, boardYtdBase, coverageText, coverageWidth, DEFAULT_SORT, extendedMove, matchTheme, memberColumns, memberExtendedSessions, memberPrice, percent,
  isLiveBoard, LIVE_BOARD_REFRESH_MS, SNAPSHOT_STALE_MS, snapshotFooterText, sortMembers, sortThemes, themeColumns, type ThemeSort,
} from "./model";

const LIVE_LEAD = "live · ";
type SnapshotPayload = { asOf: string; stale: boolean; access?: "realtime" | "delayed"; regularSessionDate?: string | null; regularSessionClosedAt?: number | null };

/**
 * Refreshes a board on the user's interval, or every 15 seconds while it is
 * live: a Pro account's prices are renewed that often on the server.
 */
function useBoardRefresh(resource: { updatedAt: number | null; load: (force?: boolean) => Promise<unknown>; data: { payload: SnapshotPayload } | null }) {
  const live = isLiveBoard(resource.data?.payload);
  const { load } = resource;
  useAutoRefresh(resource.updatedAt, live ? () => void load(true) : () => void load(), { intervalMs: live ? LIVE_BOARD_REFRESH_MS : null });
}

function useSnapshotFooter(id: string, resource: { loading: boolean; error: string | null; data: { payload: SnapshotPayload; stale: boolean; refreshError: string | null } | null }, focused: boolean, enabled = true) {
  const data = resource.data;
  const age = useUpdatedAgo(data ? Date.parse(data.payload.asOf) : null);
  const payload = data?.payload;
  // Outside the regular session the figures are a close, so the footer names it, not the snapshot's time.
  const text = age && payload ? snapshotFooterText(payload, age) : null;
  const info = useMemo(() => {
    if (!text) return [];
    // A live board says so as the other live panes do, before the snapshot's age.
    if (text.startsWith(LIVE_LEAD)) {
      return [{ id: "snapshot-live", parts: [{ text: "live", tone: "positive" as const }] },
        { id: "snapshot", parts: [{ text: text.slice(LIVE_LEAD.length), tone: "muted" as const }] }];
    }
    return splitDelayedStatus({ id: "snapshot", parts: [{ text, tone: "muted" }] });
  }, [text]);
  // The server flag includes retained historical returns; it does not mean the daily board is old.
  const snapshotStale = !!data && Date.now() - Date.parse(data.payload.asOf) > SNAPSHOT_STALE_MS;
  usePaneStatusFooter({ registrationId: id, enabled, loading: resource.loading && !!data,
    error: data ? null : resource.error, stale: !!data && (data.stale || snapshotStale || !!resource.error), info });
  usePaneNoticeFooter({ registrationId: `${id}:notices`, focused, enabled,
    notices: data?.refreshError ? [data.refreshError] : [] });
}

function Members({ id, width, height, focused }: { id: string; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const { navigateTicker } = usePluginTickerActions();
  const loader = useCallback((force: boolean) => loadMembers(id, force), [id]);
  const initialData = useCallback(() => cachedMembers(id), [id]);
  const resource = useAsyncResource(loader, { initialData });
  const data = resource.data?.payload;
  const [sort, setSort] = usePluginPaneState<ThemeSort>("memberSort", DEFAULT_SORT);
  const [selected, setSelected] = usePluginPaneState<string | null>("member", null);
  const rows = useMemo(() => sortMembers(data?.members ?? [], sort), [data, sort]);
  // Price and 1D are the regular session's; a pre-market or after-hours print gets its own column when a member has one.
  const extendedSessionsKey = useMemo(() => memberExtendedSessions(data?.members ?? []).join(","), [data]);
  // YTD names the close it is measured from, `31 Dec`.
  const ytdBase = data ? boardYtdBase(data) : null;
  const columns = useMemo(() => memberColumns(width, extendedSessionsKey ? extendedSessionsKey.split(",") as ExtendedSession[] : [], ytdBase),
    [extendedSessionsKey, width, ytdBase]);
  useBoardRefresh(resource);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  useSnapshotFooter("themes:members", resource, focused);
  const memberList = useMemo(() => data ? { title: data.theme.name, watchlistName: data.theme.name, members: rows } : null, [data, rows]);
  useMembersMenu("themes:members-menu", memberList);
  const renderCell = useCallback((row: ThemeMember, column: DataTableColumn): DataTableCell => {
    if (column.id === "symbol") return { text: row.symbol, color: colors.textBright };
    if (column.id === "name") return { text: row.name ?? "--", color: colors.text };
    if (column.id === "price") return { text: memberPrice(row.price), value: row.price };
    if (column.id === "preMarket" || column.id === "afterHours") {
      // The extended print's move from the close in Price.
      const move = extendedMove(row, column.id === "preMarket" ? "PRE" : "POST");
      return { text: percent(move), value: move, color: move === null ? colors.textMuted : shownPriceColor(move, 2, colors) };
    }
    const value = row[column.id as ThemePeriod];
    return { text: percent(value), value, color: value === null ? colors.textMuted : shownPriceColor(value, 2, colors) };
  }, [colors]);
  return <PaneStatusBody subject="theme members" loading={!data && resource.loading} error={!data ? resource.error : null}>
    {data ? <DataTableView<ThemeMember> columns={columns} items={rows} focused={focused} rootWidth={width} rootHeight={height}
      selection={{ kind: "id", selectedId: selected, getId: (row) => row.symbol, onChange: setSelected }}
      getItemKey={(row) => row.symbol} onActivate={(row) => navigateTicker(row.exchange ? `${row.symbol}:${row.exchange}` : row.symbol)}
      renderCell={renderCell} sortColumnId={sort.columnId} sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId, { firstDirection: ["symbol", "name"].includes(columnId) ? "asc" : "desc" }))}
      onSortChange={(columnId, direction) => setSort({ columnId, direction })}
      resetScrollKey={`${id}:${sort.columnId}:${sort.direction}`} selectedTextOverridesCellColor emptyStateTitle="No members in this theme." /> : null}
  </PaneStatusBody>;
}

/**
 * The open theme: the `THEM nuclear` argument until the user moves, then what
 * they opened. Null means "use fallback" in pane persistence; an empty string
 * explicitly returns to the list.
 */
export function useOpenTheme() {
  return usePluginPaneState("openTheme", usePaneInstance()?.params?.theme ?? "");
}

interface ThemesBoardProps {
  width: number;
  height: number;
  focused: boolean;
  /** The pane's tab strip, kept above the list and an open theme alike. */
  tabStrip?: ReactNode;
  tabRows?: number;
}

/** The Themes tab of the Sector Performance pane (`THEM`). */
export function ThemesBoard({ width, height, focused, tabStrip, tabRows = 0 }: ThemesBoardProps) {
  const colors = useThemeColors();
  const [opened, setOpened] = useOpenTheme();
  const bodyHeight = Math.max(1, height - tabRows);
  const [selected, setSelected] = usePluginPaneState<string | null>("theme", null);
  const [sort, setSort] = usePluginPaneState<ThemeSort>("sort", DEFAULT_SORT);
  const resource = useAsyncResource(loadThemes, { initialData: cachedThemes });
  const data = resource.data?.payload;
  const rows = useMemo(() => sortThemes(data?.themes ?? [], sort), [data, sort]);
  const columns = useMemo(() => themeColumns(width, data?.themes ?? [], data ? boardYtdBase(data) : null), [width, data]);
  const theme = opened && data ? matchTheme(data.themes, opened) : null;
  useBoardRefresh(resource);
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: !opened });
  useSnapshotFooter("themes:list", resource, focused, !opened || !data);
  const renderCell = useCallback((row: ThemeSummary, column: DataTableColumn): DataTableCell => {
    if (column.id === "name") return { text: row.name, color: colors.textBright };
    if (column.id === "memberCount") return { text: String(row.memberCount), value: row.memberCount, color: colors.textMuted };
    if (column.id === "best" || column.id === "worst") {
      const member = row[column.id];
      return { text: member ? `${member.symbol} ${percent(member.changePercent)}` : "--", value: member?.changePercent ?? null,
        color: member ? shownPriceColor(member.changePercent, 2, colors) : colors.textMuted };
    }
    const breadth = column.id === "breadth";
    const metric = breadth ? row.breadth : row.returns[column.id as ThemePeriod];
    const suffixWidth = coverageWidth((data?.themes ?? []).map((theme) => breadth ? theme.breadth : theme.returns[column.id as ThemePeriod]));
    const color = metric.value === null || breadth ? colors.textMuted : shownPriceColor(metric.value, 2, colors);
    const valueText = breadth && metric.value !== null ? `${Math.round(metric.value)}%` : percent(metric.value);
    const suffix = coverageText(metric);
    return { text: aggregateText(metric, breadth), value: metric.value,
      color, content: suffixWidth ? <Box flexDirection="row" width={column.width} justifyContent="flex-end">
        <Text fg={color}>{valueText}</Text><Text fg={colors.textMuted}>{suffix.padStart(suffixWidth)}</Text>
      </Box> : undefined };
  }, [colors, data]);
  return <Box width={width} height={height} flexDirection="column">
    {tabStrip}
    <PaneStatusBody subject="thematic baskets" loading={!data && resource.loading} error={!data ? resource.error : null}>
      {data ? <DataTableStackView<ThemeSummary> columns={columns} items={rows} rootWidth={width} rootHeight={bodyHeight} focused={focused}
        selection={{ kind: "id", selectedId: selected, getId: (row) => row.id, onChange: setSelected }}
        getItemKey={(row) => row.id} onActivate={(row) => setOpened(row.id)}
        detailOpen={!!opened} onBack={() => setOpened("")} detailTitle={theme?.name ?? opened}
        detailContent={theme ? <Members key={theme.id} id={theme.id} width={width} height={Math.max(1, bodyHeight - 1)} focused={focused} />
          : <PaneStatusBody subject="theme" error="No matching theme. Return to the list to choose a basket." />}
        renderCell={renderCell} sortColumnId={sort.columnId} sortDirection={sort.direction}
        onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId, { firstDirection: columnId === "name" ? "asc" : "desc" }))}
        onSortChange={(columnId, direction) => setSort({ columnId, direction })}
        resetScrollKey={`${sort.columnId}:${sort.direction}`} selectedTextOverridesCellColor emptyStateTitle="No themes available." /> : null}
    </PaneStatusBody>
  </Box>;
}
