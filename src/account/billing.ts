import type { CloudPricing } from "../api-client";
import { t, tf } from "../i18n";

const DEFAULT_TRIAL_DAYS = 7;

function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export type CloudBillingInterval = "month" | "year";

/**
 * Pro price for one billing interval, suffixed with the period. Falls back to
 * the current price when `/pricing` is unreachable so the table never renders
 * a blank cell.
 */
export function formatCloudPrice(
  pricing: CloudPricing | null | undefined,
  interval: CloudBillingInterval = "month",
): string {
  const yearly = interval === "year";
  if (!pricing) return yearly ? t("$630/yr") : t("$70/mo");
  const amount = formatUsdCents((yearly ? pricing.yearly : pricing.monthly).amount);
  return yearly ? tf("{amount}/yr", { amount }) : tf("{amount}/mo", { amount });
}

export function formatCloudMonthlyPrice(pricing: CloudPricing | null | undefined): string {
  return formatCloudPrice(pricing, "month");
}

/** Whole months of the monthly price the yearly price leaves unpaid, e.g. 3. */
export function monthsFreeYearly(pricing: CloudPricing | null | undefined): number {
  if (!pricing || pricing.monthly.amount <= 0) return 0;
  const saved = (pricing.monthly.amount * 12 - pricing.yearly.amount) / pricing.monthly.amount;
  return saved > 0 ? Math.round(saved) : 0;
}

/** Short calendar date for the trial countdown, e.g. "Aug 11". */
export function formatTrialEnd(endsAt: Date | null | undefined): string | null {
  if (!endsAt || Number.isNaN(endsAt.getTime())) return null;
  return endsAt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Pro-column note for the plan comparison, e.g. "7-day free trial". The trial
 * is part of the Pro subscription (card required, cancel before it converts),
 * so it is never advertised as something the free plan includes.
 */
export function formatTrialOffer(pricing: CloudPricing | null | undefined): string {
  return tf("{days}-day free trial", { days: trialDaysOf(pricing) });
}

/** The trial length `/pricing` gives, or today's length when it is unreachable. */
export function trialDaysOf(pricing: CloudPricing | null | undefined): number {
  return pricing?.trialDays ?? DEFAULT_TRIAL_DAYS;
}
