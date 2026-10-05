import { useCallback, useMemo } from "react";
import type { ThemeMember, ThemePeriod, ThemeSummary } from "../../../api-client/themes";
import { DataTableStackView, DataTableView, PaneStatusBody, usePaneNoticeFooter, usePaneStatusFooter, type DataTableCell, type DataTableColumn } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, usePluginTickerActions, useUpdatedAgo } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import { priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text } from "../../../ui";
import { nextHeaderSort } from "../../../utils/sort-values";
import { cachedMembers, cachedThemes, loadMembers, loadThemes } from "./client";
import { aggregateText, coverageWidth, DEFAULT_SORT, matchTheme, memberColumns, memberPrice, percent, sortMembers, sortThemes, themeColumns, type ThemeSort } from "./model";

function useSnapshotFooter(id: string, resource: { loading: boolean; error: string | null; data: { payload: { asOf: string; stale: boolean }; stale: boolean; refreshError: string | null } | null }, focused: boolean, enabled = true) {
  const data = resource.data;
  const age = useUpdatedAgo(data ? Date.parse(data.payload.asOf) : null);
  const info = useMemo(() => age ? [{ id: "snapshot", parts: [{ text: `15m delayed · snapshot ${age}`, tone: "muted" as const }] }] : [], [age]);
  // The server flag includes retained historical returns; it does not mean the daily board is old.
  const snapshotStale = !!data && Date.now() - Date.parse(data.payload.asOf) > 30 * 60_000;
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
  const columns = useMemo(() => memberColumns(width), [width]);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  useSnapshotFooter("themes:members", resource, focused);
  const renderCell = useCallback((row: ThemeMember, column: DataTableColumn): DataTableCell => {
    if (column.id === "symbol") return { text: row.symbol, color: colors.textBright };
    if (column.id === "name") return { text: row.name ?? "--", color: colors.text };
    if (column.id === "price") return { text: memberPrice(row.price), value: row.price };
    const value = row[column.id as ThemePeriod];
    return { text: percent(value), value, color: value === null ? colors.textMuted : priceColor(value, colors) };
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

export function ThemesPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const initialTheme = usePaneInstance()?.params?.theme ?? "";
  // Null means "use fallback" in pane persistence; an empty string explicitly returns to the list.
  const [opened, setOpened] = usePluginPaneState("openTheme", initialTheme);
  const [selected, setSelected] = usePluginPaneState<string | null>("theme", null);
  const [sort, setSort] = usePluginPaneState<ThemeSort>("sort", DEFAULT_SORT);
  const resource = useAsyncResource(loadThemes, { initialData: cachedThemes });
  const data = resource.data?.payload;
  const rows = useMemo(() => sortThemes(data?.themes ?? [], sort), [data, sort]);
  const columns = useMemo(() => themeColumns(width, data?.themes ?? []), [width, data]);
  const theme = opened && data ? matchTheme(data.themes, opened) : null;
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: !opened });
  useSnapshotFooter("themes:list", resource, focused, !opened || !data);
  const renderCell = useCallback((row: ThemeSummary, column: DataTableColumn): DataTableCell => {
    if (column.id === "name") return { text: row.name, color: colors.textBright };
    if (column.id === "memberCount") return { text: String(row.memberCount), value: row.memberCount, color: colors.textMuted };
    if (column.id === "best" || column.id === "worst") {
      const member = row[column.id];
      return { text: member ? `${member.symbol} ${percent(member.changePercent)}` : "--", value: member?.changePercent ?? null,
        color: member ? priceColor(member.changePercent, colors) : colors.textMuted };
    }
    const breadth = column.id === "breadth";
    const metric = breadth ? row.breadth : row.returns[column.id as ThemePeriod];
    const suffixWidth = coverageWidth((data?.themes ?? []).map((theme) => breadth ? theme.breadth : theme.returns[column.id as ThemePeriod]));
    const color = metric.value === null || breadth ? colors.textMuted : priceColor(metric.value, colors);
    const valueText = breadth && metric.value !== null ? `${Math.round(metric.value)}%` : percent(metric.value);
    const suffix = metric.covered < metric.total ? `${metric.covered}/${metric.total}` : "";
    return { text: aggregateText(metric, breadth), value: metric.value,
      color, content: suffixWidth ? <Box flexDirection="row" width={column.width} justifyContent="flex-end">
        <Text fg={color}>{valueText}</Text><Text fg={colors.textMuted}>{suffix.padStart(suffixWidth)}</Text>
      </Box> : undefined };
  }, [colors, data]);
  return <Box width={width} height={height} flexDirection="column">
    <PaneStatusBody subject="thematic baskets" loading={!data && resource.loading} error={!data ? resource.error : null}>
      {data ? <DataTableStackView<ThemeSummary> columns={columns} items={rows} rootWidth={width} rootHeight={height} focused={focused}
        selection={{ kind: "id", selectedId: selected, getId: (row) => row.id, onChange: setSelected }}
        getItemKey={(row) => row.id} onActivate={(row) => setOpened(row.id)}
        detailOpen={!!opened} onBack={() => setOpened("")} detailTitle={theme?.name ?? opened}
        detailContent={theme ? <Members key={theme.id} id={theme.id} width={width} height={Math.max(1, height - 1)} focused={focused} />
          : <PaneStatusBody subject="theme" error="No matching theme. Return to the list to choose a basket." />}
        renderCell={renderCell} sortColumnId={sort.columnId} sortDirection={sort.direction}
        onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId, { firstDirection: columnId === "name" ? "asc" : "desc" }))}
        onSortChange={(columnId, direction) => setSort({ columnId, direction })}
        resetScrollKey={`${sort.columnId}:${sort.direction}`} selectedTextOverridesCellColor emptyStateTitle="No themes available." /> : null}
    </PaneStatusBody>
  </Box>;
}
