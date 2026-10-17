import { useCallback, useMemo } from "react";
import { useAsyncResource } from "../../../../react/async-resource";
import type { TickerFinancials } from "../../../../types/financials";
import {
  distributionHistory,
  forwardDividendMayHaveLapsed,
  lapsedDividend,
  type DividendLapse,
} from "../../../../utils/forward-dividend";
import { useAssetData } from "../../../runtime";

/** Whether the overview's forward yield stands, has stopped, or waits on the history that says. */
export interface ForwardDividendState {
  /** The history is still being read; the yield is held back rather than shown and then withdrawn. */
  pending: boolean;
  lapse: DividendLapse | null;
}

const CURRENT: ForwardDividendState = { pending: false, lapse: null };

/**
 * The stopped dividend behind a forward yield (lapsedDividend), read from the
 * listing's distribution history only once its ex-date is far enough past for
 * the dividend to have stopped. Without a history, Gloom Cloud's fifteen
 * months decide on the ex-date alone.
 */
export function useForwardDividendLapse(
  symbol: string | null,
  exchange: string,
  fundamentals: TickerFinancials["fundamentals"] | undefined,
): ForwardDividendState {
  const dataProvider = useAssetData();
  const forward = fundamentals?.dividendYieldBasis === "forward" && fundamentals.dividendYield != null;
  const asOf = fundamentals?.exDividendDate;
  const readsHistory = !!symbol && forward && !!dataProvider?.getCorporateActions && forwardDividendMayHaveLapsed(asOf);
  const loader = useCallback(() => dataProvider!.getCorporateActions!(symbol!, exchange), [dataProvider, exchange, symbol]);
  const cached = useMemo(() => readsHistory
    ? dataProvider?.getCachedQuery?.("getCorporateActions", [symbol!, exchange]).getSnapshot().result?.value ?? null
    : null, [dataProvider, exchange, readsHistory, symbol]);
  const resource = useAsyncResource(readsHistory ? loader : null, { initialData: () => cached });
  if (!forward) return CURRENT;
  if (!readsHistory) return { pending: false, lapse: lapsedDividend(asOf, null) };
  const actions = resource.data ?? cached;
  if (!actions && resource.loading) return { pending: true, lapse: null };
  return { pending: false, lapse: lapsedDividend(asOf, distributionHistory(actions)) };
}
