import { useCallback, useMemo } from "react";
import { useAsyncResource } from "../../../../react/async-resource";
import type { CorporateActionsData, TickerFinancials } from "../../../../types/financials";
import { measuresTrailingYield } from "../../../../market-data/quotes/live-valuation";
import {
  distributionHistory,
  forwardDividendMayHaveLapsed,
  lapsedDividend,
  type DividendLapse,
} from "../../../../utils/forward-dividend";
import { useAssetData } from "../../../runtime";

/**
 * What the overview's dividend yield reads beside the fundamentals: whether a
 * forward yield stands, has stopped, or waits on the history that says, and
 * the cash history a trailing yield is measured from.
 */
export interface OverviewDividendState {
  /** The history is still being read; the yield is held back rather than shown and then withdrawn. */
  pending: boolean;
  lapse: DividendLapse | null;
  /**
   * The listing's cash history, for a trailing yield (listingDividendYield).
   * Null while it is read and when it cannot be, which leaves Gloom Cloud's
   * yield: a trailing yield is never withdrawn, so it is not held back.
   */
  actions?: CorporateActionsData | null;
}

const CURRENT: OverviewDividendState = { pending: false, lapse: null };

/**
 * The listing's distribution history as the overview's dividend yield reads
 * it. A trailing yield is measured from it as DVD measures it. A forward
 * yield's stopped dividend (lapsedDividend) is read from it only once its
 * ex-date is far enough past for the dividend to have stopped; without a
 * history, Gloom Cloud's fifteen months decide on the ex-date alone.
 */
export function useOverviewDividend(
  symbol: string | null,
  exchange: string,
  fundamentals: TickerFinancials["fundamentals"] | undefined,
): OverviewDividendState {
  const dataProvider = useAssetData();
  const forward = fundamentals?.dividendYieldBasis === "forward" && fundamentals.dividendYield != null;
  const trailing = measuresTrailingYield(fundamentals);
  const asOf = fundamentals?.exDividendDate;
  const readsHistory = !!symbol && !!dataProvider?.getCorporateActions && (trailing || (forward && forwardDividendMayHaveLapsed(asOf)));
  const loader = useCallback(() => dataProvider!.getCorporateActions!(symbol!, exchange), [dataProvider, exchange, symbol]);
  const cached = useMemo(() => readsHistory
    ? dataProvider?.getCachedQuery?.("getCorporateActions", [symbol!, exchange]).getSnapshot().result?.value ?? null
    : null, [dataProvider, exchange, readsHistory, symbol]);
  const resource = useAsyncResource(readsHistory ? loader : null, { initialData: () => cached });
  const actions = readsHistory ? resource.data ?? cached : null;
  if (trailing) return { pending: false, lapse: null, actions };
  if (!forward) return CURRENT;
  if (!readsHistory) return { pending: false, lapse: lapsedDividend(asOf, null) };
  if (!actions && resource.loading) return { pending: true, lapse: null };
  return { pending: false, lapse: lapsedDividend(asOf, distributionHistory(actions)) };
}
