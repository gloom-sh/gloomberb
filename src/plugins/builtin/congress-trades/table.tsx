import { TextAttributes } from "../../../ui";
import { TickerBadgeList, type DataTableCell } from "../../../components";
import { colors } from "../../../theme/colors";
import type {
  CloudCongressMemberPayload,
  CloudCongressTradePayload,
  CloudCongressTickerPayload,
} from "../../../api-client";
import {
  formatAmountRange,
  formatLag,
  formatShortDate,
  type MemberColumn,
  type TradeColumn,
  type TickerColumn,
} from "./model";

export function sideColor(side: CloudCongressTradePayload["side"], selected: boolean): string {
  if (selected) return colors.selectedText;
  if (side === "BUY") return colors.positive;
  if (side === "SELL") return colors.negative;
  if (side === "EXCHANGE") return colors.warning;
  return colors.textDim;
}

export function renderCongressTradeCell(
  trade: CloudCongressTradePayload,
  column: TradeColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "filed":
      return { text: column.width >= 10 ? trade.filingDate : formatShortDate(trade.filingDate), color: selectedColor ?? colors.textDim };
    case "tx":
      return { text: column.width >= 10 ? trade.transactionDate ?? "--" : formatShortDate(trade.transactionDate), color: selectedColor ?? colors.textDim };
    case "lag":
      return { text: `${formatLag(trade.lagDays)}${(trade.lagDays ?? 0) > 45 ? "!" : ""}`, color: selectedColor ?? ((trade.lagDays ?? 0) > 45 ? colors.warning : colors.textDim) };
    case "member":
      return { text: trade.memberName, color: selectedColor ?? colors.text };
    case "side":
      return { text: trade.side, color: sideColor(trade.side, rowState.selected), attributes: TextAttributes.BOLD };
    case "ticker":
      return {
        text: trade.ticker ?? "--",
        content: trade.ticker ? (
          <TickerBadgeList
            symbols={[trade.ticker]}
            width={column.width}
            fallbackColor={selectedColor ?? colors.positive}
          />
        ) : undefined,
        color: selectedColor ?? (trade.ticker ? colors.positive : colors.textDim),
        attributes: trade.ticker ? TextAttributes.BOLD : 0,
      };
    case "amount":
      return {
        text: formatAmountRange(trade.amountLow, trade.amountHigh, trade.amount),
        color: selectedColor ?? colors.textBright,
      };
    case "asset":
      return { text: trade.assetName, color: selectedColor ?? colors.text };
    case "owner":
      return { text: trade.owner, color: selectedColor ?? colors.textDim };
  }
}

export function renderCongressTickerCell(ticker: CloudCongressTickerPayload, column: TickerColumn, _index: number, row: { selected: boolean }): DataTableCell {
  const selectedColor = row.selected ? colors.selectedText : undefined;
  if (column.id === "ticker") return { text: ticker.ticker, color: selectedColor ?? colors.textBright };
  if (column.id === "range") return { text: formatAmountRange(ticker.estimatedLow, ticker.estimatedHigh), color: selectedColor ?? colors.text };
  if (column.id === "lastFilingDate") return { text: ticker.lastFilingDate ?? "--", color: selectedColor ?? colors.textDim };
  return { text: String(ticker[column.id]), color: selectedColor ?? (column.id === "buyCount" ? colors.positive : column.id === "sellCount" ? colors.negative : colors.text) };
}

export function renderCongressMemberCell(
  member: CloudCongressMemberPayload,
  column: MemberColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  switch (column.id) {
    case "member":
      return { text: member.memberName, color: selectedColor ?? colors.text };
    case "district":
      return { text: member.stateDistrict || "--", color: selectedColor ?? colors.textDim };
    case "trades":
      return { text: String(member.tradeCount), color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
    case "buys":
      return { text: String(member.buyCount), color: selectedColor ?? colors.positive };
    case "sells":
      return { text: String(member.sellCount), color: selectedColor ?? colors.negative };
    case "range":
      return { text: formatAmountRange(member.estimatedLow, member.estimatedHigh), color: selectedColor ?? colors.textBright };
    case "last":
      return { text: formatShortDate(member.lastFilingDate), color: selectedColor ?? colors.textDim };
    case "lag":
      return { text: formatLag(member.avgLagDays), color: selectedColor ?? colors.textDim };
  }
}
