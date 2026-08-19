import { useMemo } from "react";
import { Box, Text } from "../../../../ui";
import { EmptyState, Spinner, TickerListTableView, type DataTableKeyEvent } from "../../../../components";
import type { ColumnConfig } from "../../../../types/config";
import type { TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { colors } from "../../../../theme/colors";
import { t } from "../../../../i18n";
import { getColumnValue, type ColumnContext } from "../../portfolio-list/metrics";
import type { ValidatedScreenerResult } from "./contract";
import type { AiScreenerTab, ScreenerSortPreference } from "./model";
import { truncateWithEllipsis, wrapTextLines } from "../../../../utils/text-wrap";

export function AiScreenerResultsView({
  activeSort,
  activeTab,
  columnContext,
  columns,
  contentHeight,
  cursorSymbol,
  financialsMap,
  focused,
  isRunningActiveTab,
  promptDirty,
  resultMap,
  sortedTickers,
  width,
  onHeaderClick,
  onRootKeyDown,
  onRowActivate,
  setCursorSymbol,
}: {
  activeSort: ScreenerSortPreference;
  activeTab: AiScreenerTab | null;
  columnContext: ColumnContext;
  columns: ColumnConfig[];
  contentHeight: number;
  cursorSymbol: string | null;
  financialsMap: Map<string, TickerFinancials>;
  focused: boolean;
  isRunningActiveTab: boolean;
  promptDirty: boolean;
  resultMap: Map<string, ValidatedScreenerResult>;
  sortedTickers: TickerRecord[];
  width: number;
  onHeaderClick: (columnId: string) => void;
  onRootKeyDown: (event: DataTableKeyEvent) => boolean | void;
  onRowActivate: (ticker: TickerRecord) => void;
  setCursorSymbol: (symbol: string) => void;
}) {
  const detailTextWidth = Math.max(12, width - 2);
  const warningColor = colors.borderFocused;
  const summaryLines = useMemo(() => (
    activeTab?.summary
      ? wrapTextLines(activeTab.summary, detailTextWidth, 2)
      : []
  ), [activeTab?.summary, detailTextWidth]);

  return (
    <>
      {activeTab?.lastError && (
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          {wrapTextLines(activeTab.lastError, detailTextWidth, 2).map((line, index) => (
            <Box key={`error:${index}`} height={1}>
              <Text fg={colors.negative}>{line || " "}</Text>
            </Box>
          ))}
        </Box>
      )}

      {activeTab?.lastWarning && !activeTab.lastError && (
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          {wrapTextLines(activeTab.lastWarning, detailTextWidth, 2).map((line, index) => (
            <Box key={`warning:${index}`} height={1}>
              <Text fg={warningColor}>{line || " "}</Text>
            </Box>
          ))}
        </Box>
      )}

      {activeTab && promptDirty && !isRunningActiveTab && activeTab.results.length > 0 && (
        <Box flexDirection="column" paddingX={1} paddingTop={1} height={1}>
          <Text fg={warningColor}>
            {t("Prompt or provider changed. These matches are from the previous run.")}
          </Text>
        </Box>
      )}

      {activeTab && summaryLines.length > 0 && !activeTab.lastError && (
        <Box flexDirection="column" paddingX={1}>
          {summaryLines.map((line, index) => (
            <Box key={`summary:${index}`} height={1}>
              <Text fg={colors.textDim}>{line || " "}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box flexGrow={1} minHeight={contentHeight}>
        {!activeTab ? (
          <Box padding={1} flexGrow={1}>
            <EmptyState title={t("No AI screeners yet.")} hint={t("Click + to create one.")} />
          </Box>
        ) : isRunningActiveTab && activeTab.results.length === 0 ? (
          <Box padding={1} flexGrow={1}>
            <Spinner label={t("Running AI screener...")} />
          </Box>
        ) : (
          <TickerListTableView
            focused={focused}
            columns={columns}
            tickers={sortedTickers}
            cursorSymbol={cursorSymbol}
            setCursorSymbol={setCursorSymbol}
            resolveCell={(column, ticker, financials) => {
              if (column.id === "ticker") {
                return {
                  text: ticker.metadata.ticker,
                };
              }
              if (column.id === "reason") {
                return {
                  text: truncateWithEllipsis(resultMap.get(ticker.metadata.ticker)?.reason ?? "", column.width),
                };
              }
              return getColumnValue(column, ticker, financials, columnContext);
            }}
            financialsMap={financialsMap}
            sortColumnId={activeSort.columnId}
            sortDirection={activeSort.direction}
            onHeaderClick={onHeaderClick}
            onRootKeyDown={onRootKeyDown}
            resetScrollKey={activeTab.id}
            onRowActivate={onRowActivate}
            emptyTitle="No matches yet."
            emptyHint={promptDirty && !isRunningActiveTab
              ? "Prompt changed. Refresh to rerun."
              : "Run this screener. Use PS to customize columns."}
          />
        )}
      </Box>
    </>
  );
}
