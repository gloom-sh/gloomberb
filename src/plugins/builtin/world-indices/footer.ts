import { usePaneFooter } from "../../../components";
import {
  quoteBoardFooterInfo,
  quoteBoardStatus,
  type BoardQuoteMap,
} from "../shared/use-quote-board";

export function useWorldIndicesFooter(quotes: BoardQuoteMap) {
  const status = quoteBoardStatus(quotes);

  usePaneFooter(
    "world-indices",
    () => ({ info: quoteBoardFooterInfo(status) }),
    [status.latestTs, status.loading, status.stale, status.unavailable],
  );
}
