import { useCallback, useMemo, useState } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import {
  DataTableView,
  usePaneFooter,
  type DataTableCell,
  type DataTableKeyEvent,
} from "../../../components";
import type { AnalystResearchData } from "../../../types/financials";
import { blendHex, colors, priceColor } from "../../../theme/colors";
import { formatCurrency, formatPercent } from "../../../utils/format";
import { useAssetData } from "../../runtime";
import { handleRefreshKey, loadingErrorFooterInfo } from "../shared/table-pane";
import { useBoundTicker as useSymbolBinding, useTickerRequest } from "../shared/ticker-request";
import { loadAnalystResearch } from "./client";
import {
  DEFAULT_RATING_SORT,
  buildAnalystSummaryLines,
  buildRatingColumns,
  formatRatingTarget,
  nextRatingSortPreference,
  ratingTargetDelta,
  sortRatingRows,
  targetUpside,
  type RatingColumn,
  type RatingSortPreference,
} from "./analyst-model";

export {
  buildAnalystSummaryLines,
  buildRatingColumns,
  formatRatingTarget,
  nextRatingSortPreference,
  sortRatingRows,
  type RatingSortPreference,
} from "./analyst-model";

function ratingActionColor(action: string | undefined): string {
  const normalized = action?.toLowerCase() ?? "";
  if (normalized.includes("upgrade")) return colors.positive;
  if (normalized.includes("downgrade")) return colors.negative;
  return colors.textDim;
}

function ratingTargetBackground(delta: number | null): string | undefined {
  if (delta == null || delta === 0) return undefined;
  return blendHex(colors.bg, delta > 0 ? colors.positive : colors.negative, 0.42);
}

/**
 * Price targets and the recommendation mix are pane content, not status, so the
 * summary block owns them and the footer stays empty unless something changed.
 */
function AnalystSummary({ data }: { data: AnalystResearchData | null }) {
  const target = data?.priceTarget;
  const upside = targetUpside(target);
  const currency = target?.currency ?? data?.currency ?? "USD";
  const lines = buildAnalystSummaryLines(data);

  // The table body already reports loading, error, and empty states.
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1} height={1 + lines.length}>
      <Box height={1} flexDirection="row">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {target?.average != null ? formatCurrency(target.average, currency) : "-"}
        </Text>
        <Text fg={colors.textDim}> avg target </Text>
        <Text fg={upside == null ? colors.textDim : priceColor(upside)}>
          {upside != null ? formatPercent(upside) : "-"}
        </Text>
        <Text fg={colors.textDim}> upside</Text>
      </Box>
      {lines.map((line) => (
        <Box key={line} height={1}>
          <Text fg={colors.textDim}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function AnalystResearchView({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const dataProvider = useAssetData();
  const { symbol, exchange } = useSymbolBinding();
  const [sortPreference, setSortPreference] = useState<RatingSortPreference>(DEFAULT_RATING_SORT);
  const loader = useCallback((nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider) throw new Error("Analyst data unavailable");
    return loadAnalystResearch(
      dataProvider,
      nextSymbol,
      nextExchange,
      forceRefresh ? { cacheMode: "refresh" } : undefined,
    );
  }, [dataProvider]);
  const { data, loading, error, reload } = useTickerRequest<AnalystResearchData>(loader, symbol, exchange);
  const rows = useMemo(() => sortRatingRows(data?.ratings ?? [], sortPreference), [data?.ratings, sortPreference]);
  const ratingCurrency = data?.priceTarget?.currency ?? data?.currency ?? "USD";
  const columns = useMemo(
    () => buildRatingColumns(data?.ratings ?? [], ratingCurrency),
    [data?.ratings, ratingCurrency],
  );

  const renderCell = useCallback((
    row: AnalystResearchData["ratings"][number],
    column: RatingColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "date":
        return { text: row.date, color: selectedColor ?? colors.textDim };
      case "firm":
        return { text: row.firm, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "action":
        return { text: row.action ?? "-", color: selectedColor ?? ratingActionColor(row.action) };
      case "current":
        return { text: row.current ?? "-", color: selectedColor ?? colors.text };
      case "target": {
        const delta = ratingTargetDelta(row);
        const hasTarget = row.currentPriceTarget != null || row.priorPriceTarget != null;
        return {
          text: formatRatingTarget(row, ratingCurrency, column),
          color: selectedColor ?? (hasTarget ? colors.textBright : colors.textDim),
          backgroundColor: rowState.selected ? undefined : ratingTargetBackground(delta),
          attributes: hasTarget ? TextAttributes.BOLD : undefined,
        };
      }
      case "prior":
        return { text: row.prior ?? "-", color: selectedColor ?? colors.textDim };
    }
  }, [ratingCurrency]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    return handleRefreshKey(event, reload, { stopPropagation: true });
  }, [reload]);
  const handleHeaderClick = useCallback((columnId: string) => {
    setSortPreference((current) => nextRatingSortPreference(current, columnId));
  }, []);

  usePaneFooter("analyst-research", () => ({
    info: loadingErrorFooterInfo(loading, error),
  }), [error, loading]);

  return (
    <DataTableView<AnalystResearchData["ratings"][number], RatingColumn>
      focused={focused}
      selection={{ kind: "none" }}
      rootWidth={width}
      rootHeight={height}
      rootBefore={<AnalystSummary data={data} />}
      onRootKeyDown={handleKeyDown}
      columns={columns}
      items={rows}
      sortColumnId={sortPreference.columnId}
      sortDirection={sortPreference.direction}
      onHeaderClick={handleHeaderClick}
      getItemKey={(row, index) => `${row.date}:${row.firm}:${index}`}
      renderCell={renderCell}
      emptyStateTitle={loading ? "Loading analyst data..." : error ?? "No analyst data"}
    />
  );
}
