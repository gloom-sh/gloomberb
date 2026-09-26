import type { PublicPortfolioAnalytics } from "../api-client";

const analyticsByPortfolio = new Map<string, PublicPortfolioAnalytics>();

function finiteMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeAnalytics(analytics: PublicPortfolioAnalytics | null | undefined): PublicPortfolioAnalytics | null {
  if (!analytics) return null;
  const normalized: PublicPortfolioAnalytics = {
    oneYearReturn: finiteMetric(analytics.oneYearReturn),
    spyBeta: finiteMetric(analytics.spyBeta),
    basis: analytics.basis === "account" || analytics.basis === "holdings" ? analytics.basis : null,
  };
  return normalized.oneYearReturn != null || normalized.spyBeta != null ? normalized : null;
}

function sameAnalytics(left: PublicPortfolioAnalytics | null, right: PublicPortfolioAnalytics | null): boolean {
  return left?.oneYearReturn === right?.oneYearReturn
    && left?.spyBeta === right?.spyBeta
    && (left?.basis ?? null) === (right?.basis ?? null);
}

export function setSyncedProfileAnalytics(
  portfolioId: string,
  analytics: PublicPortfolioAnalytics | null | undefined,
): boolean {
  const normalized = normalizeAnalytics(analytics);
  const current = analyticsByPortfolio.get(portfolioId) ?? null;
  if (sameAnalytics(current, normalized)) return false;
  if (normalized) {
    analyticsByPortfolio.set(portfolioId, normalized);
  } else {
    analyticsByPortfolio.delete(portfolioId);
  }
  return true;
}

export function getSyncedProfileAnalytics(portfolioId: string): PublicPortfolioAnalytics | null {
  return analyticsByPortfolio.get(portfolioId) ?? null;
}
