import { usePaneFooter, type PaneFooterSegment } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useQuoteDelayFooter } from "../shared/cloud-upgrade";
import {
  boardErrorMessage,
  boardQuotes,
  quoteBoardFooterInfo,
  quoteBoardStatus,
  type BoardQuoteMap,
} from "../shared/use-quote-board";

export function useWorldIndicesFooter(quotes: BoardQuoteMap, onRefresh: () => void, focused: boolean) {
  const status = quoteBoardStatus(quotes);
  const errorMessage = boardErrorMessage(quotes);

  usePaneRefreshKey(onRefresh, { focused });
  // Signed out or free, the indices' quotes are delayed ones.
  const quoteDelay = useQuoteDelayFooter(boardQuotes(quotes), "indices-delay");

  usePaneFooter(
    "world-indices",
    () => {
      const info: PaneFooterSegment[] = quoteBoardFooterInfo(status);
      if (errorMessage) info.push({ id: "reason", parts: [{ text: errorMessage, tone: "warning" }] });
      if (quoteDelay) info.push(quoteDelay);
      return { info };
    },
    [errorMessage, focused, onRefresh, quoteDelay, status.latestTs, status.loading, status.savedAt, status.stale, status.unavailable],
  );
}
