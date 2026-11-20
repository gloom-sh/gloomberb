import type { PaneFooterSegment } from "../../../components";
import { observationFooterSegment, timestampFooterSegment } from "../../../components/layout/pane/footer/freshness";
import { shownPriceColor } from "../../../theme/colors";
import { formatPercentRaw } from "../../../utils/format";
import { INDEX_SHORT } from "./model";
import type { MarketSummaryQuote } from "./screener";

export function moverFreshnessFooter(asOf: number | string | null | undefined, checkedAt: number | null): PaneFooterSegment[] {
  const observation = observationFooterSegment(asOf)
    ?? { id: "as-of", parts: [{ text: "observation time unavailable", tone: "muted" as const }] };
  const checked = timestampFooterSegment("checked-at", "checked", checkedAt);
  return [observation, ...(checked ? [checked] : [])];
}

/** The index summary every list's footer leads with. */
export function summaryFooterSegments(summaryQuotes: readonly MarketSummaryQuote[]): PaneFooterSegment[] {
  return summaryQuotes.map((idx) => {
    const short = INDEX_SHORT[idx.symbol] ?? idx.symbol;
    return {
      id: `summary:${idx.symbol}`,
      parts: [
        { text: short, tone: "label" as const },
        { text: formatPercentRaw(idx.changePercent), tone: "value" as const, color: shownPriceColor(idx.changePercent, 2), bold: true },
      ],
    };
  });
}
