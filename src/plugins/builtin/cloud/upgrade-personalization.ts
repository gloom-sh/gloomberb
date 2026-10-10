import { useEffect, useMemo, useReducer } from "react";
import { apiClient } from "../../../api-client";
import { usePlanAccess } from "../../../api-client/plan-access";
import { exposeUpgradePersonalized, knownUpgradePersonalized } from "../../../api-client/research-activity";
import { useOptionalAppSelector } from "../../../state/app/context";
import { useAppVisible } from "../../../state/app/activity";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord, Watchlist } from "../../../types/ticker";
import { selectUpgradeTickers } from "./upgrade-tickers";

const NO_TICKERS = new Map<string, TickerRecord>();
const NO_FINANCIALS = new Map<string, TickerFinancials>();
const NO_WATCHLISTS: Watchlist[] = [];

/** This device's top tickers for an upgrade surface; stable while the selection is. */
function useUpgradeTickers(): readonly string[] {
  const tickers = useOptionalAppSelector((state) => state.tickers, NO_TICKERS);
  const financials = useOptionalAppSelector((state) => state.financials, NO_FINANCIALS);
  const watchlists = useOptionalAppSelector((state) => state.config.watchlists, NO_WATCHLISTS);
  const key = useMemo(
    () => selectUpgradeTickers(tickers.values(), financials, watchlists).join(","),
    [financials, tickers, watchlists],
  );
  return useMemo(() => (key ? key.split(",") : []), [key]);
}

/**
 * The tickers to name on an upgrade surface, or null for the generic copy.
 * Asks for the `upgrade_personalized` arm once the surface is `shown` to a
 * signed-in free account with at least one usable ticker; everyone else, the
 * control arm, and anyone the API leaves out keep the generic copy. Until the
 * first answer of the session arrives the surface shows the generic copy.
 */
export function useUpgradePersonalization(placement: string, shown: boolean): readonly string[] | null {
  const tickers = useUpgradeTickers();
  const access = usePlanAccess();
  const visible = useAppVisible();
  const accountId = access.signedIn ? apiClient.getCurrentUser()?.id ?? null : null;
  const eligible = shown && visible && !!accountId && !access.hasProAccess && tickers.length > 0;
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);

  useEffect(() => {
    if (!eligible || !accountId) return;
    let live = true;
    void exposeUpgradePersonalized(placement).then(() => {
      if (live) refresh();
    });
    return () => {
      live = false;
    };
  }, [accountId, eligible, placement]);

  if (!eligible) return null;
  // Recheck the current account and privacy flags even after an earlier answer.
  const arm = knownUpgradePersonalized();
  return arm === "personalized" ? tickers : null;
}
