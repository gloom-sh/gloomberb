import type { CorporateActionsData } from "../types/financials";
import { canonicalExchange } from "../utils/exchanges";

export const INCOMPLETE_DISTRIBUTIONS = "Distribution history incomplete";

export function isIndianEtfListing(exchange: string | undefined, name: string | undefined): boolean {
  const venue = canonicalExchange(exchange);
  return (venue === "NSE" || venue === "BSE") && /\b(?:ETF|BeES)\b/i.test(name ?? "");
}

export function fundCorporateActions(actions: CorporateActionsData, { uncertainEmptyPayouts = false } = {}): CorporateActionsData {
  const { earnings: _earnings, ...coverage } = actions.coverage ?? {};
  return {
    ...actions,
    earnings: [],
    coverage: {
      ...coverage,
      ...(uncertainEmptyPayouts && actions.dividends.length === 0 ? { dividends: "unavailable" } : {}),
    },
  };
}
