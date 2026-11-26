import { MISSING_VALUE } from "../../../utils/format";
import { TextAttributes } from "../../../ui";
import { TickerBadgeList, type DataTableCell } from "../../../components";
import { colors } from "../../../theme/colors";
import { signedColor } from "../shared/research-cells";
import { dayCell, formatDay } from "../../../components/ui/day-cell";
import type {
  CloudCongressMemberPayload,
  CloudCongressTradePayload,
  CloudCongressTickerPayload,
} from "../../../api-client";
import {
  congressRowAsset,
  congressRowLineCount,
  formatAmountRange,
  formatCongressReturn,
  formatLag,
  roundCongressReturn,
  type CongressTradeRow,
  type MemberColumn,
  type TradeColumn,
  type TickerColumn,
} from "./model";

/** A return or its excess over SPY takes the shared signed colours wherever CG shows one, by its digits. */
export function congressReturnColor(value: number | null | undefined): string {
  return signedColor(value == null ? value : roundCongressReturn(value), colors);
}

function congressReturnCell(value: number | null | undefined): DataTableCell {
  return { text: formatCongressReturn(value), color: congressReturnColor(value) };
}

function sideColor(side: CloudCongressTradePayload["side"]): string {
  if (side === "BUY") return colors.positive;
  if (side === "SELL") return colors.negative;
  if (side === "EXCHANGE") return colors.text;
  return colors.textDim;
}

/** A filing day: in full where its column has room (02 Nov 2026), else without its year (02 Nov). */
function filingDayCell(day: string | null, width: number): DataTableCell {
  return { ...dayCell(day, width >= 11 ? "full" : "no-year"), color: colors.textDim };
}

export function renderCongressTradeCell(
  trade: CongressTradeRow,
  column: TradeColumn,
  _index: number,
  rowState: { selected: boolean },
): DataTableCell {
  switch (column.id) {
    case "returnSinceTx": case "returnSinceFiling": case "excessSinceFiling": return congressReturnCell(trade[column.id]);
    case "filed":
      return filingDayCell(trade.filingDate, column.width);
    case "tx":
      return filingDayCell(trade.transactionDate, column.width);
    case "lag":
      return { text: `${formatLag(trade.lagDays)}${(trade.lagDays ?? 0) > 45 ? "!" : ""}`, color: (trade.lagDays ?? 0) > 45 ? colors.warning : colors.textDim };
    case "member":
      return { text: trade.memberName, color: colors.text };
    case "side":
      return { text: trade.side, color: sideColor(trade.side), attributes: TextAttributes.BOLD };
    case "ticker":
      return {
        text: trade.ticker ?? (column.assetFallback && trade.assetName ? congressRowAsset(trade) : MISSING_VALUE),
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
      // The ASSET column keeps a fold's count whole and cuts the name before it; the narrow TICKER fallback lets the name lead.
      return { text: congressRowAsset(trade), keepEnd: congressRowLineCount(trade) || undefined, color: colors.text };
    case "owner":
      return { text: trade.owner, color: colors.textDim };
  }
}

export function renderCongressTickerCell(ticker: CloudCongressTickerPayload, column: TickerColumn): DataTableCell {
  if (column.id === "ticker") return { text: ticker.ticker, color: colors.textBright };
  if (column.id === "range") return { text: formatAmountRange(ticker.estimatedLow, ticker.estimatedHigh), color: colors.text };
  if (column.id === "lastFilingDate") return { ...dayCell(ticker.lastFilingDate), color: colors.textDim };
  return { text: String(ticker[column.id]), color: column.id === "buyCount" ? colors.positive : column.id === "sellCount" ? colors.negative : colors.text };
}

export function renderCongressMemberCell(
  member: CloudCongressMemberPayload,
  column: MemberColumn,
): DataTableCell {
  switch (column.id) {
    case "party": return { text: member.party ?? MISSING_VALUE, color: colors.textDim };
    case "medianReturn": case "medianExcessSinceFiling": return congressReturnCell(member[column.id]);
    case "buyHitRate": return { text: member.buyHitRate == null ? MISSING_VALUE : `${member.buyHitRate.toFixed(0)}%`, color: colors.text };
    case "member":
      return { text: member.memberName, color: colors.text };
    case "district":
      return { text: member.stateDistrict || MISSING_VALUE, color: colors.textDim };
    case "trades":
      return { text: String(member.tradeCount), color: colors.textBright, attributes: TextAttributes.BOLD };
    case "buys":
      return { text: String(member.buyCount), color: colors.positive };
    case "sells":
      return { text: String(member.sellCount), color: colors.negative };
    case "range":
      return { text: formatAmountRange(member.estimatedLow, member.estimatedHigh), color: colors.textBright };
    case "last":
      return { text: formatDay(member.lastFilingDate, "no-year"), ...(member.lastFilingDate ? { value: member.lastFilingDate } : {}), color: colors.textDim };
    case "lag":
      return { text: formatLag(member.avgLagDays), color: colors.textDim };
  }
}
