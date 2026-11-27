import type { OptionContract, OptionsChain } from "../../../../types/financials";
import { formatDaysToExpiry } from "../../../../utils/option-expiry";
import { daysToExpiryFrom } from "./pricing";

export const OPTION_IV_UNIT = "annualized %";

export function isMarkedChain(chain: OptionsChain): boolean {
  return chain.calls.some((contract) => contract.mark != null) || chain.puts.some((contract) => contract.mark != null);
}

export function optionIvFields(contract: OptionContract | undefined, iv: number | null | undefined, filled?: boolean) {
  const value = contract?.mark ? contract.mark.iv : iv;
  const usable = !!contract && !contract.quoteStale && value != null && Number.isFinite(value) && value > 0;
  return {
    iv: usable ? value : null,
    ivSource: contract?.quoteStale ? "stale quote" : !usable ? null : contract.mark ? "mark" : filled ? "filled" : "solved",
  };
}

export function optionChainAsOf(asOf?: string): string | null {
  const time = asOf ? Date.parse(asOf) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function optionGreekClock(expiration: number, now: number, venue?: string, valuationTime?: number): string | null {
  const countdown = formatDaysToExpiry(expiration, now, venue);
  if (valuationTime == null || valuationTime === now || countdown === "expired") return null;
  const valuationDays = `~${Math.round(daysToExpiryFrom(expiration, valuationTime))}d`;
  return `~${countdown}` === valuationDays ? null : valuationDays;
}

export function optionExpiryClock(expiration: number, now: number, venue?: string, valuationTime?: number): string {
  const countdown = formatDaysToExpiry(expiration, now, venue);
  const valuationDays = optionGreekClock(expiration, now, venue, valuationTime);
  return valuationDays == null ? countdown : `${countdown} now · ${valuationDays} for Greeks`;
}
