import type { BrokerAdapter, BrokerPosition } from "../../types/broker";
import type { AppConfig, OnboardingProgress, OnboardingStage } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { getManualPortfolioPosition } from "../../plugins/builtin/portfolio-list/mutations";

/**
 * Stages older builds persisted that the wizard no longer renders. A profile
 * that was mid-flow when it upgraded lands on the closest surviving step.
 */
const LEGACY_STAGES: Partial<Record<OnboardingStage, OnboardingStage>> = {
  welcome: "portfolio",
  "add-ticker": "portfolio",
  verify: "upgrade",
};

export function getOnboardingProgress(config: AppConfig): OnboardingProgress {
  const progress = config.onboardingProgress ?? { version: 1, stage: "portfolio" };
  const stage = LEGACY_STAGES[progress.stage];
  return stage ? { ...progress, stage } : progress;
}

export function withOnboardingProgress(
  config: AppConfig,
  patch: Partial<OnboardingProgress> & Pick<OnboardingProgress, "stage">,
): AppConfig {
  return {
    ...config,
    onboardingComplete: false,
    onboardingProgress: {
      ...getOnboardingProgress(config),
      ...patch,
      version: 1,
    },
  };
}

export interface BrokerOption {
  id: string;
  name: string;
  adapter: BrokerAdapter;
}

export function getConnectableBrokerOptions(brokers: Iterable<[string, BrokerAdapter]>): BrokerOption[] {
  const options: BrokerOption[] = [];
  for (const [id, adapter] of brokers) {
    if (adapter.configSchema.length > 0) {
      options.push({ id, name: adapter.name, adapter });
    }
  }
  return options;
}

/** The manual portfolio onboarding writes into: the first one without a broker. */
export function getOnboardingPortfolioId(config: AppConfig): string {
  return config.portfolios.find((portfolio) => !portfolio.brokerInstanceId && !portfolio.brokerId)?.id ?? "main";
}

export interface OnboardingPositionRow {
  symbol: string;
  name: string;
  currency: string;
  /** Null for a company the user follows without holding it. */
  shares: number | null;
  avgCost: number | null;
  /** Last quote seen for the symbol, when one has been fetched. */
  price: number | null;
  /** Shares times the last price (or average cost before a quote arrives). */
  value: number | null;
}

/**
 * Manual rows in the onboarding portfolio, oldest first. Quotes come from the
 * app's financials map plus whatever the add step fetched, so a row shows a
 * value as soon as either has priced it.
 */
export function listOnboardingPositions(
  tickers: Iterable<TickerRecord>,
  portfolioId: string,
  quotes: (symbol: string) => Quote | null | undefined,
): OnboardingPositionRow[] {
  const rows: OnboardingPositionRow[] = [];
  for (const ticker of tickers) {
    if (!ticker.metadata.portfolios.includes(portfolioId)) continue;
    const position = getManualPortfolioPosition(ticker, portfolioId);
    const price = quotes(ticker.metadata.ticker)?.price;
    const shares = position?.shares ?? null;
    const avgCost = position?.avgCost ?? null;
    const basis = typeof price === "number" && Number.isFinite(price) ? price : avgCost;
    rows.push({
      symbol: ticker.metadata.ticker,
      name: ticker.metadata.name || "",
      currency: position?.currency ?? ticker.metadata.currency ?? "USD",
      shares,
      avgCost,
      price: typeof price === "number" && Number.isFinite(price) ? price : null,
      value: shares !== null && basis !== null ? shares * basis : null,
    });
  }
  return rows;
}

/**
 * The company the workspace opens on: the largest holding by value, then the
 * largest by share count when nothing is priced, then the first row added.
 */
export function pickLargestPosition(rows: readonly OnboardingPositionRow[]): OnboardingPositionRow | null {
  if (rows.length === 0) return null;
  let best = rows[0]!;
  for (const row of rows.slice(1)) {
    if ((row.value ?? -1) > (best.value ?? -1)) {
      best = row;
    } else if (row.value === null && best.value === null && (row.shares ?? -1) > (best.shares ?? -1)) {
      best = row;
    }
  }
  return best;
}

/** Same rule for a broker import, where every position carries its own cost basis. */
export function pickLargestBrokerPosition(positions: readonly BrokerPosition[]): BrokerPosition | null {
  let best: BrokerPosition | null = null;
  let bestValue = -1;
  for (const position of positions) {
    if (!position.ticker) continue;
    const value = Math.abs((position.shares ?? 0) * (position.avgCost ?? 0));
    if (!best || value > bestValue) {
      best = position;
      bestValue = value;
    }
  }
  return best;
}
