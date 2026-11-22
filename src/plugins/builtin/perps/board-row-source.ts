import type { PerpBoardRow } from "../../../api-client/perps";
import type { DataTableRowSource } from "../../../components/ui/data-table/types";
import { getSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { buildQuoteKey, instrumentFromQuoteTarget, resolveEntryData } from "../../../market-data/selectors";
import { perpQuoteTarget, withLiveReading } from "./live-rows";

/** The latest row for actions as well as the independently rendered cells. */
export function readPerpBoardRow(row: PerpBoardRow): PerpBoardRow {
  const target = perpQuoteTarget(row.marketId, "screener");
  const coordinator = getSharedMarketDataCoordinator();
  return target && coordinator ? withLiveReading(row, resolveEntryData(coordinator.getQuoteEntry(instrumentFromQuoteTarget(target)))) : row;
}

export const perpBoardRowSource: DataTableRowSource<PerpBoardRow> = {
  subscribe(row, listener) {
    const target = perpQuoteTarget(row.marketId, "screener");
    const coordinator = getSharedMarketDataCoordinator();
    return target && coordinator ? coordinator.subscribeKeys([buildQuoteKey(instrumentFromQuoteTarget(target))], listener) : () => {};
  },
  version(row) {
    const target = perpQuoteTarget(row.marketId, "screener");
    const coordinator = getSharedMarketDataCoordinator();
    return target && coordinator ? coordinator.getKeyVersion(buildQuoteKey(instrumentFromQuoteTarget(target))) : 0;
  },
  read: readPerpBoardRow,
};
