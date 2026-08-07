import type { ChoiceDialogChoice } from "../../../components";
import type { AccountProfile, CloudPricing, PublicPortfolioAnalytics } from "../../../api-client";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import { formatNumber } from "../../../utils/format";
import { t, tf } from "../../../i18n";

export { truncateWithEllipsis as truncate } from "../../../utils/text-wrap";

export type AccountFieldKey =
  | "username"
  | "name"
  | "company"
  | "title"
  | "bio"
  | "profilePublic"
  | "publicEmail"
  | "xAccount"
  | "acceptUnknownDms"
  | "sharedPortfolioId"
  | "weeklyRoundupEnabled"
  | "positionAlertsEnabled"
  | "chatEmailNotificationsEnabled"
  | "emailAlertsOffAction"
  | "upgradeAction"
  | "passwordAction"
  | "deleteAccountAction";

export interface AccountDraft {
  username: string;
  name: string;
  company: string;
  title: string;
  bio: string;
  profilePublic: boolean;
  publicEmail: string;
  xAccount: string;
  sharedPortfolioId: string;
  acceptUnknownDms: boolean;
  weeklyRoundupEnabled: boolean;
  positionAlertsEnabled: boolean;
  chatEmailNotificationsEnabled: boolean;
}

interface ProfileAnalyticsPreviewMetric {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative" | "muted";
}

export interface ProfileAnalyticsPreview {
  status: "off" | "missing" | "empty" | "pending" | "ready";
  title: string;
  subtitle: string;
  metrics: ProfileAnalyticsPreviewMetric[];
  publicAnalytics: PublicPortfolioAnalytics | null;
}

export const NO_PORTFOLIO_VALUE = "__none__";

export function profileToDraft(profile: AccountProfile | null): AccountDraft {
  return {
    username: profile?.username ?? "",
    name: profile?.name ?? "",
    company: profile?.company ?? "",
    title: profile?.title ?? "",
    bio: profile?.bio ?? "",
    profilePublic: profile?.profilePublic === true,
    publicEmail: profile?.publicEmail ?? "",
    xAccount: profile?.xAccount ?? "",
    sharedPortfolioId: profile?.sharedPortfolioId ?? "",
    acceptUnknownDms: profile?.acceptUnknownDms === true,
    weeklyRoundupEnabled: profile?.weeklyRoundupEnabled === false ? false : true,
    positionAlertsEnabled: profile?.positionAlertsEnabled === false ? false : true,
    chatEmailNotificationsEnabled: profile?.chatEmailNotificationsEnabled === false ? false : true,
  };
}

export function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function formatPlan(plan: AccountProfile["plan"] | null | undefined): string {
  return plan === "pro" ? t("Pro") : t("Free");
}

const DEFAULT_TRIAL_DAYS = 7;

export interface PlanPriceDisplay {
  /** Charged price, already suffixed with the billing period. */
  price: string;
  /** List price to strike through, or null when the list price is the price. */
  anchor: string | null;
  note: string | null;
}

function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * Monthly Pro price for the plan comparison. Falls back to the list price when
 * `/pricing` is unreachable so the table never renders a blank cell.
 */
export function formatCloudMonthlyPrice(pricing: CloudPricing | null | undefined): PlanPriceDisplay {
  if (!pricing) return { price: t("$49/mo"), anchor: null, note: null };
  const monthly = pricing.monthly;
  // Without the founding discount the list price is the price, shown plainly.
  if (!pricing.founding || monthly.anchorAmount <= monthly.amount) {
    return {
      price: tf("{amount}/mo", { amount: formatUsdCents(monthly.anchorAmount) }),
      anchor: null,
      note: null,
    };
  }
  return {
    price: tf("{amount}/mo", { amount: formatUsdCents(monthly.amount) }),
    anchor: tf("{amount}/mo", { amount: formatUsdCents(monthly.anchorAmount) }),
    note: t("Founding price"),
  };
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
  return tf("{days}-day free trial", { days: pricing?.trialDays ?? DEFAULT_TRIAL_DAYS });
}

export function countPortfolioHoldings(tickers: ReadonlyMap<string, TickerRecord>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of tickers.values()) {
    for (const portfolioId of record.metadata.portfolios) {
      counts[portfolioId] = (counts[portfolioId] ?? 0) + 1;
    }
  }
  return counts;
}

export function buildPortfolioChoices(portfolios: Portfolio[], holdingCounts: Record<string, number>): ChoiceDialogChoice[] {
  return [
    { id: NO_PORTFOLIO_VALUE, label: t("None"), detail: t("Off"), description: t("Do not show portfolio analytics on your public profile.") },
    ...portfolios.map((portfolio) => ({
      id: portfolio.id,
      label: portfolio.name,
      detail: tf("{count} tickers", { count: holdingCounts[portfolio.id] ?? 0 }),
      description: t("Shares this portfolio's 1Y return and SPY Beta on your public profile."),
    })),
  ];
}

export function portfolioOptionIds(portfolios: Portfolio[]): string[] {
  return [NO_PORTFOLIO_VALUE, ...portfolios.map((portfolio) => portfolio.id)];
}

export function selectedPortfolioLabel(portfolios: Portfolio[], value: string): string {
  if (!value) return t("None");
  return portfolios.find((portfolio) => portfolio.id === value)?.name ?? value;
}

function signedReturn(value: number): string {
  const percent = value * 100;
  return `${percent >= 0 ? "+" : ""}${formatNumber(percent, 2)}%`;
}

function signedTone(value: number | null | undefined): ProfileAnalyticsPreviewMetric["tone"] {
  if (value == null || !Number.isFinite(value)) return "muted";
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "muted";
}

function finiteMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePublicAnalytics(analytics: PublicPortfolioAnalytics | null | undefined): PublicPortfolioAnalytics | null {
  const normalized: PublicPortfolioAnalytics = {
    oneYearReturn: finiteMetric(analytics?.oneYearReturn),
    spyBeta: finiteMetric(analytics?.spyBeta),
  };
  return normalized.oneYearReturn != null || normalized.spyBeta != null ? normalized : null;
}

function buildPublicAnalyticsMetrics(analytics: PublicPortfolioAnalytics): ProfileAnalyticsPreviewMetric[] {
  const metrics: ProfileAnalyticsPreviewMetric[] = [];
  if (analytics.oneYearReturn != null) {
    metrics.push({
      id: "one-year",
      label: "1Y",
      value: signedReturn(analytics.oneYearReturn),
      tone: signedTone(analytics.oneYearReturn),
    });
  }
  if (analytics.spyBeta != null) {
    metrics.push({
      id: "beta",
      label: "SPY Beta",
      value: formatNumber(analytics.spyBeta, 2),
    });
  }
  return metrics;
}

export function getPortfolioPositionTickers(
  tickers: ReadonlyMap<string, TickerRecord>,
  portfolioId: string,
): TickerRecord[] {
  return [...tickers.values()].filter((ticker) => (
    ticker.metadata.positions.some((position) => position.portfolio === portfolioId)
  ));
}

export function computeCumulativeReturn(
  returns: Array<{ dateKey: string; value: number }>,
  options?: { sinceDateKey?: string },
): number | null {
  const filtered = options?.sinceDateKey
    ? returns.filter((point) => point.dateKey >= options.sinceDateKey!)
    : returns;
  if (filtered.length === 0) return null;
  const value = filtered.reduce((acc, point) => (
    Number.isFinite(point.value) ? acc * (1 + point.value) : acc
  ), 1) - 1;
  return Number.isFinite(value) ? value : null;
}

export function buildProfileAnalyticsPreview({
  beta,
  portfolio,
  portfolioTickers,
  selectedPortfolioId,
  oneYearReturn,
}: {
  beta: number | null;
  portfolio: Portfolio | null;
  portfolioTickers: TickerRecord[];
  selectedPortfolioId: string;
  oneYearReturn: number | null;
}): ProfileAnalyticsPreview {
  if (!selectedPortfolioId) {
    return {
      status: "off",
      title: t("No public portfolio analytics"),
      subtitle: t("Choose a portfolio to preview the public profile metrics."),
      metrics: [],
      publicAnalytics: null,
    };
  }

  if (!portfolio) {
    return {
      status: "missing",
      title: t("Portfolio not found"),
      subtitle: selectedPortfolioId,
      metrics: [],
      publicAnalytics: null,
    };
  }

  if (portfolioTickers.length === 0) {
    return {
      status: "empty",
      title: portfolio.name,
      subtitle: t("No positions to preview yet."),
      metrics: [],
      publicAnalytics: null,
    };
  }

  const publicAnalytics: PublicPortfolioAnalytics = {
    oneYearReturn: finiteMetric(oneYearReturn),
    spyBeta: finiteMetric(beta),
  };
  const hasSharedMetric = publicAnalytics.oneYearReturn != null || publicAnalytics.spyBeta != null;

  return {
    status: "ready",
    title: portfolio.name,
    subtitle: "",
    publicAnalytics: hasSharedMetric ? publicAnalytics : null,
    metrics: [
      {
        id: "one-year",
        label: "1Y",
        value: oneYearReturn == null ? t("Pending") : signedReturn(oneYearReturn),
        detail: oneYearReturn == null ? t("needs price history") : undefined,
        tone: signedTone(oneYearReturn),
      },
      {
        id: "beta",
        label: "SPY Beta",
        value: beta == null ? t("Pending") : formatNumber(beta, 2),
        detail: beta == null ? t("needs SPY overlap") : undefined,
        tone: beta == null ? "muted" : undefined,
      },
    ],
  };
}

export function buildPublishedProfileAnalyticsPreview({
  analytics,
  draftProfilePublic,
  portfolio,
  profileLoaded,
  savedProfilePublic,
  savedSharedPortfolioId,
  selectedPortfolioId,
  syncing,
}: {
  analytics: PublicPortfolioAnalytics | null | undefined;
  draftProfilePublic: boolean;
  portfolio: Portfolio | null;
  profileLoaded: boolean;
  savedProfilePublic: boolean;
  savedSharedPortfolioId: string;
  selectedPortfolioId: string;
  syncing: boolean;
}): ProfileAnalyticsPreview {
  if (!selectedPortfolioId) {
    return {
      status: "off",
      title: t("No public portfolio analytics"),
      subtitle: t("Choose a portfolio to publish 1Y return and SPY Beta."),
      metrics: [],
      publicAnalytics: null,
    };
  }

  if (!portfolio) {
    return {
      status: "missing",
      title: t("Portfolio not found"),
      subtitle: selectedPortfolioId,
      metrics: [],
      publicAnalytics: null,
    };
  }

  if (!profileLoaded) {
    return {
      status: "pending",
      title: portfolio.name,
      subtitle: t("Loading published metrics."),
      metrics: [],
      publicAnalytics: null,
    };
  }

  if (draftProfilePublic !== savedProfilePublic || selectedPortfolioId !== savedSharedPortfolioId) {
    return {
      status: "pending",
      title: portfolio.name,
      subtitle: t("Save profile to update published metrics."),
      metrics: [],
      publicAnalytics: null,
    };
  }

  if (!savedProfilePublic) {
    return {
      status: "off",
      title: t("No public portfolio analytics"),
      subtitle: t("Public profile is off."),
      metrics: [],
      publicAnalytics: null,
    };
  }

  const publicAnalytics = normalizePublicAnalytics(analytics);
  if (!publicAnalytics) {
    return {
      status: "pending",
      title: portfolio.name,
      subtitle: syncing ? t("Syncing published metrics.") : t("Waiting for published metrics."),
      metrics: [],
      publicAnalytics: null,
    };
  }

  return {
    status: "ready",
    title: portfolio.name,
    subtitle: "",
    metrics: buildPublicAnalyticsMetrics(publicAnalytics),
    publicAnalytics,
  };
}
