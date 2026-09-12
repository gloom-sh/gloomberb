import type { PaneFooterSegment } from "../../../components/layout/pane/footer";
import { t } from "../../../i18n";
import { isQuoteStaleForCurrentSession } from "../../../market-data/quotes/freshness";
import type { Quote } from "../../../types/financials";
import { displayWidth } from "../../../utils/format";

export function tickerQuoteFooterInfo(
  quote: Quote | undefined,
  access: PaneFooterSegment | null,
  width?: number,
): PaneFooterSegment[] {
  const info: PaneFooterSegment[] = [];
  if (isQuoteStaleForCurrentSession(quote)) {
    const status: PaneFooterSegment = { id: "ticker-research-stale", parts: [{ text: t("Stale quote"), tone: "warning" }] };
    const timestamp = new Date(quote!.lastUpdated);
    if (width != null && quote!.lastUpdated > 0 && Number.isFinite(timestamp.getTime())) {
      const sourceTime = `${timestamp.toISOString().slice(0, 16).replace("T", " ")}Z`;
      const accessWidth = access ? displayWidth(access.parts.map((part) => part.text).join(" ")) + 1 : 0;
      // Keep the warning and the existing entitlement action intact in narrow panes.
      if (displayWidth(status.parts[0]!.text) + 1 + sourceTime.length + accessWidth <= width - 2) {
        status.parts.push({ text: sourceTime, tone: "muted" });
      }
    }
    info.push(status);
  }
  if (access) info.push(access);
  return info;
}
