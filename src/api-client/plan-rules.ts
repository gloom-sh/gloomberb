// The plan rules alone, free of React and the API client, so the provider
// router can gate real-time routing on the same entitlement the panes show.

import type { Quote } from "../types/financials";
import { quoteFeedDelayMinutes } from "../market-data/market/freshness";

/**
 * Minimum shape the plan helpers need. Both `AuthUser` (from `/auth/get-session`)
 * and `AccountProfile` (from `/account/profile`) satisfy it.
 */
export interface PlanAccessUser {
  emailVerified?: boolean;
  plan?: "free" | "pro" | null;
  /** Server-computed entitlement: "pro" while a trial runs or a subscription is active. */
  effectivePlan?: "free" | "pro" | null;
  /** ISO timestamp the free Pro trial ends; null once it lapsed or never started. */
  trialEndsAt?: string | null;
}

export interface PlanAccess {
  signedIn: boolean;
  /** Signed in *and* verified, i.e. account-gated cloud features will answer. */
  emailVerified: boolean;
  /** Real-time entitlement right now: paying subscriber or an active trial. */
  hasProAccess: boolean;
  /** Paying subscriber, i.e. an upgrade CTA is no longer relevant. */
  isPayingPro: boolean;
  isTrialActive: boolean;
  /** Whole days remaining, rounded up; 1 on the final day, 0 when no trial runs. */
  trialDaysLeft: number;
  trialEndsAt: Date | null;
}

/** Delay the cloud applies to free-tier equity and options quotes. */
export const CLOUD_QUOTE_DELAY_MINUTES = 15;
/** Delay the cloud applies to free-tier news wire articles. */
export const CLOUD_NEWS_DELAY_HOURS = 12;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function resolveTrialEndsAt(user: PlanAccessUser | null | undefined): Date | null {
  if (!user?.trialEndsAt) return null;
  const endsAt = new Date(user.trialEndsAt);
  return Number.isNaN(endsAt.getTime()) ? null : endsAt;
}

function isTrialActive(user: PlanAccessUser | null | undefined, now = Date.now()): boolean {
  if (user?.emailVerified !== true) return false;
  // Card-backed trials run as plan "pro" with a trialing subscription; the server
  // only sends `trialEndsAt` while the subscription is actually in its trial.
  const endsAt = resolveTrialEndsAt(user);
  return !!endsAt && endsAt.getTime() > now;
}

function trialDaysLeft(user: PlanAccessUser | null | undefined, now = Date.now()): number {
  const endsAt = resolveTrialEndsAt(user);
  if (!endsAt) return 0;
  const remainingMs = endsAt.getTime() - now;
  if (remainingMs <= 0) return 0;
  return Math.max(1, Math.ceil(remainingMs / MS_PER_DAY));
}

/**
 * Whether the account is entitled to real-time cloud data. `effectivePlan` is the
 * server's answer, but the trial clock is re-checked locally so a session captured
 * before the trial lapsed cannot keep claiming Pro. Sessions from older servers
 * (no `effectivePlan`) fall back to the legacy verified-and-paid check.
 */
export function hasProAccess(user: PlanAccessUser | null | undefined, now = Date.now()): boolean {
  if (user?.emailVerified !== true) return false;
  if (user.plan === "pro") return true;
  if (isTrialActive(user, now)) return true;
  return user.effectivePlan === "pro" && !user.trialEndsAt;
}

/** What of a price decides whether a free account sees it late, and by how much. */
export type QuoteDelayFacts = Pick<Quote, "dataSource" | "delisting" | "priceObservation" | "providerId" | "listingExchangeName" | "exchangeName">;

/**
 * The delay in minutes an account sees on a price, null when it sees none.
 * Whether it sees one: an account without real-time access (signed out, free,
 * a trial that ended) does, on a price that is not live. A live price (a
 * coin, a broker's own feed) has none, and neither does a price with no delay
 * to speak of (a delisted line's last trade, a fund's NAV). Pro and trial
 * accounts never see one. How long: the quote's own feed delay when it states
 * one (`quoteFeedDelayMinutes`: 20 for SGX), as the quote's footer says it,
 * else the free tier's quote delay.
 */
export function freeQuoteDelayMinutes(
  access: Pick<PlanAccess, "hasProAccess">,
  quote: QuoteDelayFacts | null | undefined,
): number | null {
  if (access.hasProAccess || !quote) return null;
  if (quote.dataSource === "live" || quote.delisting || quote.priceObservation === "nav") return null;
  return quoteFeedDelayMinutes(quote) ?? CLOUD_QUOTE_DELAY_MINUTES;
}

/** The longest delay this account sees on any of `quotes` (see {@link freeQuoteDelayMinutes}), or null when none is late. */
export function freeQuotesDelayMinutes(
  access: Pick<PlanAccess, "hasProAccess">,
  quotes: Iterable<QuoteDelayFacts | null | undefined>,
): number | null {
  if (access.hasProAccess) return null;
  let longest: number | null = null;
  for (const quote of quotes) {
    const minutes = freeQuoteDelayMinutes(access, quote);
    if (minutes != null && (longest == null || minutes > longest)) longest = minutes;
  }
  return longest;
}

export function resolvePlanAccess(
  user: PlanAccessUser | null | undefined,
  now = Date.now(),
): PlanAccess {
  const trialActive = isTrialActive(user, now);
  return {
    signedIn: !!user,
    emailVerified: user?.emailVerified === true,
    hasProAccess: hasProAccess(user, now),
    isPayingPro: user?.emailVerified === true && user.plan === "pro" && !trialActive,
    isTrialActive: trialActive,
    trialDaysLeft: trialActive ? trialDaysLeft(user, now) : 0,
    trialEndsAt: resolveTrialEndsAt(user),
  };
}
