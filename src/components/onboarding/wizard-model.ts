import { brokerMethodLabel, type BrokerDirectoryEntry } from "../../brokers/directory";
import { brokerDirectoryLogo, type BrokerPluginLogo } from "../../brokers/logos";
import type { SignedInBroker } from "../../brokers/signed-in/client";
import type { BrokerAdapter, BrokerPosition } from "../../types/broker";
import type { AppConfig, OnboardingProgress, OnboardingStage } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { getManualPortfolioPosition } from "../../portfolio/mutations";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import { convertCurrency } from "../../utils/format";

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
  const saved = config.onboardingProgress ?? { version: 1, stage: "portfolio" };
  const legacy = LEGACY_STAGES[saved.stage];
  const progress = legacy ? { ...saved, stage: legacy } : saved;
  // Older builds sent Back from Gloom Cloud to the portfolio after the
  // workspace was built; such a profile resumes on the workspace.
  return isOnboardingStageFinished(progress, progress.stage) ? { ...progress, stage: "research" } : progress;
}

/** Stages the wizard reaches only once the workspace is built. */
const WORKSPACE_STAGES: ReadonlySet<OnboardingStage> = new Set(["research", "account", "upgrade", "ready"]);

/**
 * Whether the workspace is built around a holding: the portfolio and desk
 * steps are finished. Older builds saved no desks, so a later stage with a
 * holding counts too. "Which tickers do you follow?" holds the desks picked
 * before it, and the workspace is built once it closes.
 */
export function isOnboardingWorkspaceBuilt(progress: OnboardingProgress): boolean {
  if (progress.stage === "tickers") return false;
  return !!progress.tickerSymbol && (Array.isArray(progress.desks) || WORKSPACE_STAGES.has(progress.stage));
}

/**
 * A step that is done for good: the portfolio and desk steps once the
 * workspace is built (building twice would add every desk twice), and Pro
 * for an account that has it. The wizard shows them as done and never asks
 * them again.
 */
function isOnboardingStageFinished(progress: OnboardingProgress, stage: OnboardingStage, pro = false): boolean {
  if (stage === "upgrade") return pro;
  return (stage === "portfolio" || stage === "desks") && isOnboardingWorkspaceBuilt(progress);
}

/**
 * Where Back (and Esc) goes: the step the user came from, passing over any
 * that is finished for good (`pro`: the account has Pro). With no way back
 * recorded (the app restarted on this step), the step before it in the
 * flow. `visited` is the stages the user came through, oldest first; what
 * comes back is what is left of it. Null when the step has no way back.
 */
export function previousOnboardingStage(
  progress: OnboardingProgress,
  visited: readonly OnboardingStage[],
  { pro = false }: { pro?: boolean } = {},
): { stage: OnboardingStage; visited: OnboardingStage[] } | null {
  for (let index = visited.length - 1; index >= 0; index -= 1) {
    const stage = visited[index]!;
    if (stage !== progress.stage && !isOnboardingStageFinished(progress, stage, pro)) {
      return { stage, visited: visited.slice(0, index) };
    }
  }
  const stage: OnboardingStage | null = progress.stage === "account"
    ? isOnboardingWorkspaceBuilt(progress) ? "research" : "portfolio"
    : progress.stage === "upgrade"
      ? "account"
      : progress.stage === "ready"
        ? progress.accountStatus === "signed-in" && !pro ? "upgrade" : "account"
        : null;
  return stage ? { stage, visited: [] } : null;
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

/**
 * One way to connect one broker. A device option is keyed by its adapter id,
 * which is also its broker type; signing in needs no fields, only the dialog.
 */
export type BrokerOption = {
  id: string;
  name: string;
  /** How this choice connects, when the same broker is also offered another way. */
  methodLabel?: string;
  /** The broker's logo for the desktop and the web (brokers/logos.ts); null draws its initial. */
  logo?: string | null;
} & (
  | { adapter: BrokerAdapter; signedIn?: undefined }
  | { signedIn: SignedInBroker; adapter?: undefined }
);

export function getConnectableBrokerOptions(
  directory: readonly BrokerDirectoryEntry[],
  pluginLogo: BrokerPluginLogo = () => null,
): BrokerOption[] {
  const options: BrokerOption[] = [];
  for (const entry of directory) {
    const logo = brokerDirectoryLogo(entry, pluginLogo);
    for (const method of entry.methods) {
      const methodLabel = entry.methods.length > 1 ? brokerMethodLabel(entry, method) : undefined;
      options.push(method.kind === "signed-in"
        ? { id: `signed-in:${method.broker.id}`, name: entry.name, methodLabel, logo, signedIn: method.broker }
        : { id: method.adapter.id, name: method.adapter.name, methodLabel, logo, adapter: method.adapter });
    }
  }
  return options;
}

/**
 * The manual portfolio onboarding shows and writes into: the first one
 * without a broker that already holds something, so a profile whose
 * portfolios were built with the command line opens on its holdings, not on
 * the empty default; else the first one without a broker.
 */
export function getOnboardingPortfolioId(config: AppConfig, tickers: Iterable<TickerRecord> = []): string {
  const manual = config.portfolios.filter((portfolio) => !portfolio.brokerInstanceId && !portfolio.brokerId);
  const held = new Set<string>();
  for (const ticker of tickers) {
    for (const id of ticker.metadata.portfolios) held.add(id);
    for (const position of ticker.metadata.positions) if (position.shares !== 0) held.add(position.portfolio);
  }
  return (manual.find((portfolio) => held.has(portfolio.id)) ?? manual[0])?.id ?? "main";
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
    const quote = quotes(ticker.metadata.ticker);
    const price = typeof quote?.price === "number" && Number.isFinite(quote.price) ? quote.price : null;
    const shares = position?.shares ?? null;
    const avgCost = position?.avgCost ?? null;
    const costCurrency = position?.currency || ticker.metadata.currency || "USD";
    // Priced, the row is worth the quote in the listing's own currency (pence
    // in pounds), whatever currency the cost was entered in.
    const quoteUnit = price !== null ? resolveCurrencyUnit(quote?.currency || costCurrency) : null;
    rows.push({
      symbol: ticker.metadata.ticker,
      name: ticker.metadata.name || "",
      currency: quoteUnit?.currency || costCurrency,
      shares,
      avgCost,
      price,
      value: shares === null ? null
        : price !== null ? shares * price / quoteUnit!.divisor
        : avgCost !== null ? shares * avgCost
        : null,
    });
  }
  return rows;
}

/**
 * The company the workspace opens on: the largest holding by value, then the
 * largest by share count when nothing is priced, then the first row added.
 * Rows valued in more than one currency (US funds beside lira shares) compare
 * in dollars when `usdPerUnit` holds a rate for every one of them, so 2,000
 * shares at TRY55 are not taken for more than 20 SPY at $520; otherwise, and
 * for rows in one currency, the values compare as they are.
 */
export function pickLargestPosition(
  rows: readonly OnboardingPositionRow[],
  usdPerUnit?: ReadonlyMap<string, number>,
): OnboardingPositionRow | null {
  if (rows.length === 0) return null;
  const valued = rows.filter((row) => row.value !== null);
  const inDollars = (row: OnboardingPositionRow) => convertCurrency(row.value!, row.currency, "USD", new Map(usdPerUnit));
  const dollars = !!usdPerUnit
    && new Set(valued.map((row) => resolveCurrencyUnit(row.currency).currency)).size > 1
    && valued.every((row) => Number.isFinite(inDollars(row)));
  const valueOf = (row: OnboardingPositionRow) => (dollars && row.value !== null ? inDollars(row) : row.value);
  let best = rows[0]!;
  for (const row of rows.slice(1)) {
    const [value, bestValue] = [valueOf(row), valueOf(best)];
    if ((value ?? -1) > (bestValue ?? -1)) {
      best = row;
    } else if (value === null && bestValue === null && (row.shares ?? -1) > (best.shares ?? -1)) {
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
