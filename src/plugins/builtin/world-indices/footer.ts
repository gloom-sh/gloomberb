import { usePaneFooter, type PaneFooterSegment } from "../../../components";
import {
  countLoadingQuotes,
  latestQuoteTimestamp,
  type BoardQuoteMap,
} from "../shared/use-quote-board";

export function useWorldIndicesFooter(quotes: BoardQuoteMap) {
  const loadingCount = countLoadingQuotes(quotes);
  const latestQuoteTs = latestQuoteTimestamp(quotes);

  usePaneFooter("world-indices", () => {
    const info: PaneFooterSegment[] = [];
    if (loadingCount > 0) {
      info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
    }
    if (latestQuoteTs > 0) {
      info.push({
        id: "fresh",
        parts: [{
          text: new Date(latestQuoteTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          tone: "muted",
        }],
      });
    }
    return { info };
  }, [latestQuoteTs, loadingCount]);
}
