import type { AppConfig } from "../../../types/config";
import type { Portfolio, TickerPosition, TickerRecord } from "../../../types/ticker";
import { slugifyName } from "../../../utils/slugify";

export interface DeleteManualPortfolioResult {
  config: AppConfig;
  portfolio: Portfolio;
  tickers: TickerRecord[];
  cleanedTickerCount: number;
  removedPositionCount: number;
}

export interface RemoveTickerFromPortfolioResult {
  changed: boolean;
  ticker: TickerRecord;
  removedPositionCount: number;
}

export interface SetManualPortfolioPositionInput {
  shares: number;
  avgCost: number;
  currency: string;
}

export interface SetManualPortfolioPositionResult {
  ticker: TickerRecord;
  addedMembership: boolean;
  replacedPositionCount: number;
}

function clonePortfolio(portfolio: Portfolio): Portfolio {
  return { ...portfolio };
}

function normalizePortfolioName(rawName: string): string {
  return rawName.trim().toLowerCase();
}

function replaceTickerMetadata(ticker: TickerRecord, metadata: TickerRecord["metadata"]): TickerRecord {
  return {
    ...ticker,
    metadata,
  };
}

export function isManualPortfolio(portfolio: Portfolio): boolean {
  return !portfolio.brokerId && !portfolio.brokerInstanceId;
}

export function findPortfolio(config: AppConfig, rawName: string): Portfolio | null {
  const normalized = normalizePortfolioName(rawName);
  if (!normalized) return null;
  return config.portfolios.find((portfolio) =>
    portfolio.id.toLowerCase() === normalized || portfolio.name.toLowerCase() === normalized
  ) ?? null;
}

export function getManualPortfolioPosition(ticker: TickerRecord, portfolioId: string): TickerPosition | null {
  return ticker.metadata.positions.find((position) =>
    position.portfolio === portfolioId && position.broker === "manual"
  ) ?? null;
}

export function resolveManualPositionCurrency(
  rawCurrency: string | undefined,
  ticker: TickerRecord,
  portfolio: Portfolio,
  baseCurrency: string | undefined,
): string {
  return (rawCurrency?.trim() || ticker.metadata.currency || portfolio.currency || baseCurrency || "USD").toUpperCase();
}

export function createManualPortfolio(
  config: AppConfig,
  name: string,
  baseCurrency: string,
): { config: AppConfig; portfolio: Portfolio } {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Portfolio name is required.");
  }

  const id = slugifyName(trimmedName, "portfolio");
  const normalizedName = trimmedName.toLowerCase();
  const duplicate = config.portfolios.some((portfolio) =>
    portfolio.id.toLowerCase() === id || portfolio.name.toLowerCase() === normalizedName
  );
  if (duplicate) {
    throw new Error(`Portfolio "${trimmedName}" already exists.`);
  }

  const portfolio: Portfolio = {
    id,
    name: trimmedName,
    currency: (baseCurrency || config.baseCurrency || "USD").toUpperCase(),
  };

  return {
    config: {
      ...config,
      portfolios: [...config.portfolios, portfolio],
    },
    portfolio,
  };
}

export function addTickerToPortfolio(
  ticker: TickerRecord,
  portfolioId: string,
): { changed: boolean; ticker: TickerRecord } {
  if (ticker.metadata.portfolios.includes(portfolioId)) {
    return { changed: false, ticker };
  }

  return {
    changed: true,
    ticker: replaceTickerMetadata(ticker, {
      ...ticker.metadata,
      portfolios: [...ticker.metadata.portfolios, portfolioId],
    }),
  };
}

export function addTickerToWatchlist(
  ticker: TickerRecord,
  watchlistId: string,
): { changed: boolean; ticker: TickerRecord } {
  if (ticker.metadata.watchlists.includes(watchlistId)) {
    return { changed: false, ticker };
  }

  return {
    changed: true,
    ticker: replaceTickerMetadata(ticker, {
      ...ticker.metadata,
      watchlists: [...ticker.metadata.watchlists, watchlistId],
    }),
  };
}

export function removeTickerFromPortfolio(
  ticker: TickerRecord,
  portfolioId: string,
): RemoveTickerFromPortfolioResult {
  const nextPortfolios = ticker.metadata.portfolios.filter((entry) => entry !== portfolioId);
  const removedPositionCount = ticker.metadata.positions.filter((position) => position.portfolio === portfolioId).length;
  const nextPositions = ticker.metadata.positions.filter((position) => position.portfolio !== portfolioId);
  const changed =
    nextPortfolios.length !== ticker.metadata.portfolios.length
    || removedPositionCount > 0;

  if (!changed) {
    return { changed: false, ticker, removedPositionCount: 0 };
  }

  return {
    changed: true,
    removedPositionCount,
    ticker: replaceTickerMetadata(ticker, {
      ...ticker.metadata,
      portfolios: nextPortfolios,
      positions: nextPositions,
    }),
  };
}

export function setManualPortfolioPosition(
  ticker: TickerRecord,
  portfolioId: string,
  input: SetManualPortfolioPositionInput,
): SetManualPortfolioPositionResult {
  const nextCurrency = input.currency.trim().toUpperCase();
  if (!Number.isFinite(input.shares) || input.shares <= 0) {
    throw new Error("Shares must be greater than 0.");
  }
  if (!Number.isFinite(input.avgCost)) {
    throw new Error("Average cost must be a valid number.");
  }
  if (!nextCurrency) {
    throw new Error("Position currency is required.");
  }

  const replacedPositions = ticker.metadata.positions.filter((position) => position.portfolio === portfolioId);
  const replacedPositionCount = replacedPositions.length;
  // Editing a single snapshot (for example after a split) does not change its
  // acquisition date. A consolidated replacement of several lots has no one date.
  const dateAcquired = replacedPositions.length === 1 && replacedPositions[0]?.broker === "manual"
    ? replacedPositions[0].dateAcquired : undefined;
  const nextPositions = ticker.metadata.positions.filter((position) => position.portfolio !== portfolioId);
  const addedMembership = !ticker.metadata.portfolios.includes(portfolioId);

  nextPositions.push({
    portfolio: portfolioId,
    shares: input.shares,
    avgCost: input.avgCost,
    currency: nextCurrency,
    broker: "manual",
    ...(dateAcquired ? { dateAcquired } : {}),
  });

  return {
    addedMembership,
    replacedPositionCount,
    ticker: replaceTickerMetadata(ticker, {
      ...ticker.metadata,
      portfolios: addedMembership ? [...ticker.metadata.portfolios, portfolioId] : ticker.metadata.portfolios,
      positions: nextPositions,
    }),
  };
}

export function deleteManualPortfolio(
  config: AppConfig,
  tickers: TickerRecord[],
  portfolioId: string,
): DeleteManualPortfolioResult {
  const portfolio = config.portfolios.find((entry) => entry.id === portfolioId);
  if (!portfolio) {
    throw new Error("Portfolio not found.");
  }
  if (!isManualPortfolio(portfolio)) {
    throw new Error(`Portfolio "${portfolio.name}" is broker-managed and cannot be modified manually.`);
  }

  const nextConfig: AppConfig = {
    ...config,
    portfolios: config.portfolios
      .filter((entry) => entry.id !== portfolioId)
      .map(clonePortfolio),
  };

  const changedTickers: TickerRecord[] = [];
  let removedPositionCount = 0;

  for (const ticker of tickers) {
    const result = removeTickerFromPortfolio(ticker, portfolioId);
    if (!result.changed) continue;
    changedTickers.push(result.ticker);
    removedPositionCount += result.removedPositionCount;
  }

  return {
    config: nextConfig,
    portfolio: clonePortfolio(portfolio),
    tickers: changedTickers,
    cleanedTickerCount: changedTickers.length,
    removedPositionCount,
  };
}
