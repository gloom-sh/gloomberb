import { createElement } from "react";
import { TickerBadgeList } from "../../../components/ticker/badge/list";
import { TextAttributes } from "../../../ui";
import type { DataTableCell } from "../../../components";
import { colors, priceColor } from "../../../theme/colors";
import {
  actionLabel,
  formatChangeShares,
  formatMoneyCompact,
  formatPercentMaybe,
  formatRawPercentMaybe,
  formatShares,
  formatShortDate,
} from "./format";
import { positionType } from "./model";
import type {
  FilingPositionColumn,
  FilingPositionRow,
  FundBrowserColumn,
  FundBrowserRow,
  FundHoldingColumn,
  FundHoldingRow,
  FundTimelineColumn,
  FundTimelineRow,
} from "./types";

export function renderBrowserCell(
  row: FundBrowserRow,
  column: FundBrowserColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "fund":
      return {
        text: row.name,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "cik":
      return { text: row.cik, color: selectedColor ?? colors.textDim };
    case "period":
      return { text: row.periodOfReport ?? "--", color: selectedColor ?? colors.textDim };
    case "filed":
      return { text: formatShortDate(row.filedAsOfDate), color: selectedColor ?? colors.textDim };
    case "value":
      return { text: formatMoneyCompact(row.tableValueTotal), color: selectedColor ?? colors.text };
    case "rows":
      return { text: row.tableEntryTotal == null ? "--" : String(row.tableEntryTotal), color: selectedColor ?? colors.textDim };
    case "estQuarterReturn":
      return {
        text: formatRawPercentMaybe(row.estQuarterReturn),
        color: selectedColor ?? (row.estQuarterReturn == null ? colors.textDim : priceColor(row.estQuarterReturn)),
      };
  }
}

export function renderHoldingCell(
  row: FundHoldingRow,
  column: FundHoldingColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "ticker":
      if (row.ticker) {
        return {
          text: row.ticker,
          content: createElement(TickerBadgeList, {
            symbols: [row.ticker],
            width: column.width,
            fallbackColor: selectedColor ?? colors.textBright,
            liveQuote: false,
          }),
          color: selectedColor ?? colors.textBright,
        };
      }
      return {
        text: row.cusip,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "type":
      return { text: positionType(row), color: selectedColor ?? colors.textDim };
    case "issuer":
      return { text: row.issuer, color: selectedColor ?? colors.text };
    case "value":
      return { text: formatMoneyCompact(row.value), color: selectedColor ?? colors.text };
    case "estimatedPnl":
      return {
        text: formatMoneyCompact(row.estimatedPnl),
        color: selectedColor ?? (row.estimatedPnl == null ? colors.textDim : priceColor(row.estimatedPnl)),
      };
    case "weight":
      return { text: formatPercentMaybe(row.weight), color: selectedColor ?? colors.textDim };
    case "shares":
      return { text: formatShares(row.shares), color: selectedColor ?? colors.text };
    case "sharesChange":
      return {
        text: formatChangeShares(row.sharesChange),
        color: selectedColor ?? (row.sharesChange == null ? colors.textDim : priceColor(row.sharesChange)),
      };
    case "action":
      return {
        text: actionLabel(row.action),
        color: selectedColor ?? actionColor(row.action),
      };
  }
}

export function renderFilingPositionCell(
  row: FilingPositionRow,
  column: FilingPositionColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "ticker":
      if (row.ticker) {
        return {
          text: row.ticker,
          content: createElement(TickerBadgeList, {
            symbols: [row.ticker],
            width: column.width,
            fallbackColor: selectedColor ?? colors.textBright,
            liveQuote: false,
          }),
          color: selectedColor ?? colors.textBright,
        };
      }
      return {
        text: row.cusip,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "type":
      return { text: positionType(row), color: selectedColor ?? colors.textDim };
    case "issuer":
      return { text: row.issuer, color: selectedColor ?? colors.text };
    case "value":
      return { text: formatMoneyCompact(row.value), color: selectedColor ?? colors.text };
    case "weight":
      return { text: formatPercentMaybe(row.weight), color: selectedColor ?? colors.textDim };
    case "shares":
      return { text: formatShares(row.shares), color: selectedColor ?? colors.text };
    case "cusip":
      return { text: row.cusip, color: selectedColor ?? colors.textDim };
    case "discretion":
      return { text: row.investmentDiscretion || "--", color: selectedColor ?? colors.textDim };
  }
}

export function renderTimelineCell(
  row: FundTimelineRow,
  column: FundTimelineColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "period":
      return {
        text: row.periodOfReport,
        color: selectedColor ?? colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "filed":
      return { text: formatShortDate(row.filedAsOfDate), color: selectedColor ?? colors.textDim };
    case "value":
      return { text: formatMoneyCompact(row.tableValueTotal), color: selectedColor ?? colors.text };
    case "rows":
      return { text: row.tableEntryTotal == null ? "--" : String(row.tableEntryTotal), color: selectedColor ?? colors.textDim };
    case "valueChange":
      return {
        text: formatPercentMaybe(row.valueChangePercent),
        color: selectedColor ?? (row.valueChangePercent == null ? colors.textDim : priceColor(row.valueChangePercent)),
      };
    case "form":
      return {
        text: row.isAmendment ? `${row.submissionType} amended` : row.submissionType,
        color: selectedColor ?? (row.isAmendment ? colors.warning : colors.textDim),
      };
  }
}

function actionColor(action: FundHoldingRow["action"]): string {
  switch (action) {
    case "new":
    case "add":
      return colors.positive;
    case "trim":
    case "exit":
      return colors.negative;
    case "held":
      return colors.textDim;
  }
}
