import type { PaneFooterSegment } from "../../../components";
import { priceColor } from "../../../theme/colors";
import { formatPercentRaw } from "../../../utils/format";
import { INDEX_SHORT } from "./model";
import type { MarketSummaryQuote } from "./screener";

/** The index summary every list's footer leads with. */
export function summaryFooterSegments(summaryQuotes: readonly MarketSummaryQuote[]): PaneFooterSegment[] {
  return summaryQuotes.map((idx) => {
    const short = INDEX_SHORT[idx.symbol] ?? idx.symbol;
    return {
      id: `summary:${idx.symbol}`,
      parts: [
        { text: short, tone: "label" as const },
        { text: formatPercentRaw(idx.changePercent), tone: "value" as const, color: priceColor(idx.changePercent), bold: true },
      ],
    };
  });
}
