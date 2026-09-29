import { createElement } from "react";
import { TickerBadgeList } from "../../../components/ticker/badge/list";
import { TextAttributes } from "../../../ui";
import type { DataTableCell } from "../../../components";
import { colors, priceColor } from "../../../theme/colors";
import { formatShortDate } from "../../../utils/datetime-format";
import {
  actionLabel,
  formatChangeShares,
  formatMoneyCompact,
  formatPercentMaybe,
  formatWeightMaybe,
  formatRawPercentMaybe,
  formatShares,
  FILING_DAY_FORMAT,
} from "./format";
import { amendmentKind, positionType } from "./model";
import type {
  FilingPositionColumn,
  FilingPositionColumnId,
  FilingPositionRow,
  FundBrowserColumn,
  FundBrowserRow,
  FundHoldingColumn,
  FundHoldingColumnId,
  FundHoldingRow,
  FundTimelineColumn,
  FundTimelineRow,
} from "./types";

export function renderBrowserCell(
  row: FundBrowserRow,
  column: FundBrowserColumn,
): DataTableCell {
  switch (column.id) {
    case "return1": case "return2": case "return3": {
      const value = row.priorReturns?.[Number(column.id.at(-1)) - 1]?.value;
      return { text: formatRawPercentMaybe(value), color: value == null ? colors.textDim : priceColor(value) };
    }
    case "fund":
      return {
        text: row.name,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "cik":
      return { text: row.cik, color: colors.textDim };
    case "period":
      return { text: row.periodOfReport ?? "--", color: colors.textDim };
    case "filed":
      return { text: formatShortDate(row.filedAsOfDate, FILING_DAY_FORMAT), color: colors.textDim };
    case "value":
      return { text: formatMoneyCompact(row.tableValueTotal), color: colors.text };
    case "rows":
      return { text: row.tableEntryTotal == null ? "--" : String(row.tableEntryTotal), color: colors.textDim };
    case "estQuarterReturn":
      return {
        text: formatRawPercentMaybe(row.estQuarterReturn),
        color: row.estQuarterReturn == null ? colors.textDim : priceColor(row.estQuarterReturn),
      };
  }
}

type PositionColumnId = FundHoldingColumnId & FilingPositionColumnId;

/** The columns fund holdings and a filing's positions share; an unmapped holding shows its CUSIP. */
function renderPositionCell(
  row: FundHoldingRow | FilingPositionRow,
  columnId: PositionColumnId,
  width: number,
  selected: boolean,
): DataTableCell {
  switch (columnId) {
    case "ticker":
      if (row.ticker) {
        return {
          text: row.ticker,
          content: createElement(TickerBadgeList, {
            symbols: [row.ticker],
            width,
            fallbackColor: selected ? colors.selectedText : colors.textBright,
          }),
          color: colors.textBright,
        };
      }
      return {
        text: row.cusip,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "type":
      return { text: positionType(row), color: colors.textDim };
    case "issuer":
      return { text: row.issuer, color: colors.text };
    case "value":
      return { text: formatMoneyCompact(row.value), color: colors.text };
    case "weight":
      return { text: formatWeightMaybe(row.weight), color: colors.textDim };
    case "shares":
      return { text: formatShares(row.shares), color: colors.text };
  }
}

export function renderHoldingCell(
  row: FundHoldingRow,
  column: FundHoldingColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  switch (column.id) {
    case "mine": return { text: "" };
    case "estimatedPnl":
      return {
        text: formatMoneyCompact(row.estimatedPnl),
        color: row.estimatedPnl == null ? colors.textDim : priceColor(row.estimatedPnl),
      };
    case "sharesChange":
      return {
        text: formatChangeShares(row.sharesChange),
        color: row.sharesChange == null ? colors.textDim : priceColor(row.sharesChange),
      };
    case "action":
      return {
        text: actionLabel(row.action),
        color: actionColor(row.action),
      };
    default:
      return renderPositionCell(row, column.id, column.width, rowState.selected);
  }
}

export function renderFilingPositionCell(
  row: FilingPositionRow,
  column: FilingPositionColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  switch (column.id) {
    case "cusip":
      return { text: row.cusip, color: colors.textDim };
    case "discretion":
      return { text: row.investmentDiscretion || "--", color: colors.textDim };
    default:
      return renderPositionCell(row, column.id, column.width, rowState.selected);
  }
}

function amendmentLabel(row: FundTimelineRow): string | null {
  const kind = amendmentKind(row);
  if (!kind) return null;
  return kind === "restatement" ? "Restatement" : kind === "new-holdings" ? "New holdings" : "Amendment (unknown)";
}

export function renderTimelineCell(
  row: FundTimelineRow,
  column: FundTimelineColumn,
): DataTableCell {
  switch (column.id) {
    case "period":
      return {
        text: row.periodOfReport,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    case "filed":
      return { text: formatShortDate(row.filedAsOfDate, FILING_DAY_FORMAT), color: colors.textDim };
    case "value":
      return { text: formatMoneyCompact(row.tableValueTotal), color: colors.text };
    case "rows":
      return { text: row.tableEntryTotal == null ? "--" : String(row.tableEntryTotal), color: colors.textDim };
    case "valueChange":
      return {
        text: formatPercentMaybe(row.valueChangePercent),
        color: row.valueChangePercent == null ? colors.textDim : priceColor(row.valueChangePercent),
      };
    case "form":
      return {
        text: amendmentLabel(row) ?? row.submissionType,
        color: amendmentKind(row) === "unknown" ? colors.warning : colors.textDim,
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
    case "unknown":
      return colors.textDim;
  }
}
