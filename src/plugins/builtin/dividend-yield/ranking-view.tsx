import { useCallback, useMemo, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { usePluginAppActions } from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { TextAttributes } from "../../../ui";
import { mapWithConcurrency } from "../../../utils/concurrency";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { fetchDividendData } from "./client";
import { projectDividendRanking, type DividendRankingEntry } from "./ranking";

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
 * Reads every ticker at once, as `fn DVD` does: a ticker that fails keeps its
 * row, marked not read. Each reads its yields over the price its history
 * comes with.
 */
export async function loadDividendRanking(
  symbols: readonly string[],
  loadData: typeof fetchDividendData = fetchDividendData,
): Promise<DividendRankingEntry[]> {
  return mapWithConcurrency([...symbols], symbols.length, async (key): Promise<DividendRankingEntry> => {
    const listing = parsePublicTickerKey(key);
    try {
      return { symbol: key, data: await loadData(listing.symbol, null, listing.exchange ?? "") };
    } catch (error) {
      return { symbol: key, error: error instanceof Error ? error.message : String(error) };
    }
  });
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
export function DividendRankingView({ symbols, focused, width, height, loadData = fetchDividendData }: {
  symbols: readonly string[];
  focused: boolean;
  width: number;
  height: number;
  loadData?: typeof fetchDividendData;
}) {
  const key = symbols.join(",");
  const request = useCallback(() => loadDividendRanking(key.split(","), loadData), [key, loadData]);
  const resource = useAsyncResource(request, { keepPreviousData: true });
  usePaneRefreshKey(resource.reload, { focused });
  const { createPaneFromTemplate } = usePluginAppActions();
  const section = useMemo(() => resource.data ? projectDividendRanking(resource.data).sections[0] ?? null : null, [resource.data]);
  const rows = (section?.rows ?? []) as RankingRow[];
  const columns = useMemo<RankingColumn[]>(() => (section?.columns ?? []).map((column) => ({
    id: column.key,
    label: column.header,
    width: Math.max(column.header.length, COLUMN_WIDTHS[column.key] ?? 0),
    align: column.align ?? "left",
    source: column,
  })), [section]);
  const [selected, setSelected] = useState<string | null>(null);

  usePaneFooter("dividend-ranking", () => ({
    info: loadingErrorFooterInfo(resource.loading && !!resource.data, resource.data ? null : resource.error),
  }), [resource.loading, resource.data, resource.error]);

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
