import { latestRegularSessionOpen } from "../../../../market-data/market/freshness";
import type { OptionsChain } from "../../../../types/financials";
import { daysToExpiry, expiryIsoDate, isLiveOptionExpiry } from "../../../../utils/option-expiry";
import { optionQuoteSession } from "./quote-session";

export function optionExpiryFacts(expiration: number, now: number, venue?: string) {
  return {
    date: expiryIsoDate(expiration),
    daysToExpiry: daysToExpiry(expiration, now),
    expired: !isLiveOptionExpiry(expiration, now, venue),
  };
}

export function optionSnapshotFreshness(chain: OptionsChain, now: number, venue?: string, saved = false) {
  const observed = chain.asOf ? Date.parse(chain.asOf) : NaN;
  const delayMinutes = chain.delayMinutes ?? 0;
  const feedTime = now - delayMinutes * 60_000;
  const calendar = venue || "NYSE";
  const open = latestRegularSessionOpen(calendar, feedTime);
  const stale = saved || (!chain.venue && Number.isFinite(observed) && (open != null ? observed < open
    : optionQuoteSession(chain, calendar) !== optionQuoteSession({ asOf: new Date(feedTime).toISOString() }, calendar)));
  const asOf = Number.isFinite(observed) ? chain.asOf! : null;
  return {
    asOf,
    status: stale ? "stale" as const : asOf == null ? "unreported" as const
      : chain.dataSource ?? (delayMinutes > 0 ? "delayed" as const : undefined),
    ...(delayMinutes > 0 && !stale && asOf != null ? { delayMinutes } : {}),
    ...(asOf == null ? { note: "Option snapshot time not reported" } : {}),
  };
}
