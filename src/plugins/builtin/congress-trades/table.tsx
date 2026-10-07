import { TextAttributes } from "../../../ui";
import { TickerBadgeList, type DataTableCell } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatShortDate } from "../../../utils/datetime-format";
import type {
  CloudCongressMemberPayload,
  CloudCongressTradePayload,
  CloudCongressTickerPayload,
} from "../../../api-client";
import {
  formatAmountRange,
  formatCongressReturn,
  formatLag,
  FILING_DAY_FORMAT,
  tradeAssetLabel,
  type MemberColumn,
  type TradeColumn,
  type TickerColumn,
} from "./model";

function sideColor(side: CloudCongressTradePayload["side"]): string {
  if (side === "BUY") return colors.positive;
  if (side === "SELL") return colors.negative;
  if (side === "EXCHANGE") return colors.text;
  return colors.textDim;
}

export function renderCongressTradeCell(
  trade: CloudCongressTradePayload,
  column: TradeColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  switch (column.id) {
    case "returnSinceTx": case "returnSinceFiling": return { text: formatCongressReturn(trade[column.id]), color: trade[column.id] == null ? colors.textDim : trade[column.id]! >= 0 ? colors.positive : colors.negative };
    case "filed":
      return { text: column.width >= 10 ? trade.filingDate : formatShortDate(trade.filingDate, FILING_DAY_FORMAT), color: colors.textDim };
    case "tx":
      return { text: column.width >= 10 ? trade.transactionDate ?? "--" : formatShortDate(trade.transactionDate, FILING_DAY_FORMAT), color: colors.textDim };
    case "lag":
      return { text: `${formatLag(trade.lagDays)}${(trade.lagDays ?? 0) > 45 ? "!" : ""}`, color: (trade.lagDays ?? 0) > 45 ? colors.warning : colors.textDim };
    case "member":
      return { text: trade.memberName, color: colors.text };
    case "side":
      return { text: trade.side, color: sideColor(trade.side), attributes: TextAttributes.BOLD };
    case "ticker":
      return {
        text: trade.ticker ?? (column.assetFallback && trade.assetName ? trade.assetName : "--"),
        content: trade.ticker ? (
          <TickerBadgeList
            symbols={[trade.ticker]}
            width={column.width}
            fallbackColor={rowState.selected ? colors.selectedText : colors.positive}
          />
        ) : undefined,
        color: trade.ticker ? colors.positive : colors.textDim,
        attributes: trade.ticker ? TextAttributes.BOLD : 0,
      };
    case "amount":
      return {
        text: formatAmountRange(trade.amountLow, trade.amountHigh, trade.amount),
        color: colors.textBright,
      };
    case "asset":
      return { text: tradeAssetLabel(trade), color: colors.text };
    case "owner":
      return { text: trade.owner, color: colors.textDim };
  }
}

export function renderCongressTickerCell(ticker: CloudCongressTickerPayload, column: TickerColumn): DataTableCell {
  if (column.id === "ticker") return { text: ticker.ticker, color: colors.textBright };
  if (column.id === "range") return { text: formatAmountRange(ticker.estimatedLow, ticker.estimatedHigh), color: colors.text };
  if (column.id === "lastFilingDate") return { text: ticker.lastFilingDate ?? "--", color: colors.textDim };
  return { text: String(ticker[column.id]), color: column.id === "buyCount" ? colors.positive : column.id === "sellCount" ? colors.negative : colors.text };
}

export function renderCongressMemberCell(
  member: CloudCongressMemberPayload,
  column: MemberColumn,
): DataTableCell {
  switch (column.id) {
    case "party": return { text: member.party ?? "--", color: colors.textDim };
    case "medianReturn": case "buyHitRate": return { text: column.id === "buyHitRate" ? member.buyHitRate == null ? "--" : `${member.buyHitRate.toFixed(0)}%` : formatCongressReturn(member.medianReturn), color: colors.text };
    case "member":
      return { text: member.memberName, color: colors.text };
    case "district":
      return { text: member.stateDistrict || "--", color: colors.textDim };
    case "trades":
      return { text: String(member.tradeCount), color: colors.textBright, attributes: TextAttributes.BOLD };
    case "buys":
      return { text: String(member.buyCount), color: colors.positive };
    case "sells":
      return { text: String(member.sellCount), color: colors.negative };
    case "range":
      return { text: formatAmountRange(member.estimatedLow, member.estimatedHigh), color: colors.textBright };
    case "last":
      return { text: formatShortDate(member.lastFilingDate, FILING_DAY_FORMAT), color: colors.textDim };
    case "lag":
      return { text: formatLag(member.avgLagDays), color: colors.textDim };
  }
}
