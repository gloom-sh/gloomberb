import { useCallback, useMemo, useRef } from "react";
import { apiClient } from "../../../api-client";
import {
  DataTableView,
  PaneStatusBody,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useAssetData, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useAppSelector } from "../../../state/app/context";
import { resolveSavedInstrument } from "../../../tickers/saved-instrument";
import { colors } from "../../../theme/colors";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { TextAttributes } from "../../../ui";
import { compareSortValues, nextHeaderSort, type SortComparableValue, type SortPreference } from "../../../utils/sort-values";
import { SignInWall } from "../cloud/auth-actions";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { fetchDividendData } from "./client";
import { dividendRankingReads, type DividendReadContext } from "./headless";
import { projectDividendRanking, type DividendRankingEntry } from "./ranking";
import { readDividendRanking, type DividendRankingReads } from "./ranking-reads";

/** The pane setting a ranking of several tickers is opened with (`shot DVD KO JNJ`). */
export const RANK_SYMBOLS_SETTING = "rankSymbols";

/** The tickers a pane ranks, from its settings: two or more, or none for a pane of one ticker. */
export function rankSymbolsOf(settings: Readonly<Record<string, unknown>> | undefined): string[] {
  const value = settings?.[RANK_SYMBOLS_SETTING];
  const symbols = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];
  return symbols.length > 1 ? symbols : [];
}

/** How wide each of the ranking's columns starts, in characters; a column not named fits its header. */
const COLUMN_WIDTHS: Record<string, number> = { symbol: 10, lastExDate: 10, payDate: 10, note: 24, yieldBasis: 24 };
/** Growth figures read by their sign, as the single-ticker pane colors them. */
const SIGNED_COLUMNS = new Set(["growth1Y", "growth3Y"]);
const DATE_COLUMNS = new Set(["lastExDate", "payDate", "secYieldAsOf"]);

type RankingRow = Record<string, unknown> & { symbol: string };
type RankingColumn = DataTableColumn & { source: HeadlessPaneColumn };
/**
 * The order `fn DVD` ranks in: trailing yield, highest first. A stable sort
 * of the ranked rows keeps a ticker not read last among those with no yield.
 */
const RANKED_ORDER: SortPreference<string> = { columnId: "trailingYield", direction: "desc" };

function sortRankingRows(rows: RankingRow[], sort: SortPreference<string>): RankingRow[] {
  const { columnId, direction } = sort;
  if (!columnId) return rows;
  return [...rows].sort((left, right) => compareSortValues(left[columnId] as SortComparableValue, right[columnId] as SortComparableValue, direction));
}

/** Signed out, every read is refused for the account: the pane shows the wall the single-ticker DVD shows. */
function needsSignIn(entries: readonly DividendRankingEntry[] | null): boolean {
  return !!entries?.length && entries.every((entry) => !("data" in entry))
    && entries.some((entry) => "error" in entry && isCloudSessionRequired(entry.error));
}

function cellText(column: HeadlessPaneColumn, row: RankingRow): string {
  const value = row[column.key];
  const format = column.textFormat ?? column.format;
  return format ? format(value, row) : value == null ? "" : String(value);
}

/**
 * Several tickers ranked by trailing yield in one table, with the columns and
 * figures `fn DVD A B C` prints; Enter opens a ticker's own dividend pane.
 */
export function DividendRankingView({ symbols, focused, width, height, loadData }: {
  symbols: readonly string[];
  focused: boolean;
  width: number;
  height: number;
  /** One listing's history alone, without the quote `fn DVD` prices it at; for tests. */
  loadData?: typeof fetchDividendData;
}) {
  const key = symbols.join(",");
  const marketData = useAssetData();
  const cloudSession = useResearchCloudSession();
  // A key reads the listing `fn DVD` reads for it: its own venue, else the one its saved ticker is on.
  // Through a ref, so a quote that updates a saved ticker does not read the ranking again.
  const tickers = useAppSelector((state) => state.tickers);
  const tickersRef = useRef(tickers);
  tickersRef.current = tickers;
  const reads = useMemo<DividendRankingReads>(() => {
    const resolveInstrument = (typed: string) => resolveSavedInstrument(typed, (saved) => tickersRef.current.get(saved));
    // `fn DVD`'s own reads: the listing's quote for the price, the stated forward rate, a fund's bond facts.
    if (marketData && !loadData) return dividendRankingReads({ marketData, apiClient, resolveInstrument } satisfies DividendReadContext);
    const history = loadData ?? fetchDividendData;
    return { loadData: async (typed) => {
      const listing = await resolveInstrument(typed);
      return history(listing.symbol, null, listing.exchange ?? "");
    } };
  }, [loadData, marketData]);
  // A sign-in or a verified email reads the ranking again.
  const request = useCallback(() => readDividendRanking(key.split(","), reads), [key, reads, cloudSession.requestKey]);
  const resource = useAsyncResource(request, { keepPreviousData: true });
  const authWall = needsSignIn(resource.data);
  const { createPaneFromTemplate } = usePluginAppActions();
  const section = useMemo(() => resource.data ? projectDividendRanking(resource.data).sections[0] ?? null : null, [resource.data]);
  const [sort, setSort] = usePluginPaneState<SortPreference<string>>("dividend-ranking:sort", RANKED_ORDER);
  const rows = useMemo(() => sortRankingRows((section?.rows ?? []) as RankingRow[], sort), [section, sort]);
  const columns = useMemo<RankingColumn[]>(() => (section?.columns ?? []).map((column) => ({
    id: column.key,
    label: column.header,
    width: Math.max(column.header.length, COLUMN_WIDTHS[column.key] ?? 0),
    align: column.align === "right" ? "right" : "left",
    source: column,
  })), [section]);
  const [selected, setSelected] = usePluginPaneState<string | null>("dividend-ranking:selected", null);

  usePaneFooter("dividend-ranking", () => ({
    info: loadingErrorFooterInfo(resource.loading && !!resource.data, resource.data ? null : resource.error),
  }), [resource.loading, resource.data, resource.error]);
  usePaneRefreshKey(resource.reload, { focused, enabled: !authWall });

  const renderCell = useCallback((row: RankingRow, column: RankingColumn): DataTableCell => {
    const text = cellText(column.source, row);
    const value = row[column.id];
    if (column.id === "symbol") return { text, color: colors.textBright, attributes: TextAttributes.BOLD };
    if (column.id === "note") return { text, color: colors.warning };
    if (DATE_COLUMNS.has(column.id) || column.id === "yieldBasis") return { text, color: colors.textDim };
    if (SIGNED_COLUMNS.has(column.id) && typeof value === "number") {
      return { text, color: value > 0 ? colors.positive : value < 0 ? colors.negative : colors.text };
    }
    return { text };
  }, []);

  if (authWall) return <SignInWall placement="dividend-yield-signin" action="view dividend history" needsVerification={cloudSession.needsVerification} />;

  return (
    <PaneStatusBody
      subject="dividends"
      loading={!resource.data && resource.loading}
      error={!resource.data ? resource.error : null}
      empty={false}
    >
      <DataTableView<RankingRow, RankingColumn>
        focused={focused}
        columns={columns}
        items={rows}
        rootWidth={width}
        rootHeight={height}
        freezeFirstColumn
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        // A third click on a column returns to the ranking.
        onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id, {
          firstDirection: id === "symbol" || id === "note" || id === "yieldBasis" ? "asc" : "desc", resetTo: RANKED_ORDER }))}
        getItemKey={(row) => row.symbol}
        selection={{ kind: "id", selectedId: rows.some((row) => row.symbol === selected) ? selected! : rows[0]?.symbol ?? "",
          getId: (row) => row.symbol, onChange: (id) => setSelected(id) }}
        onActivate={(row) => createPaneFromTemplate("dividend-yield-pane", { symbol: row.symbol })}
        renderCell={renderCell}
        selectedTextOverridesCellColor
        emptyStateTitle="No tickers"
      />
    </PaneStatusBody>
  );
}
