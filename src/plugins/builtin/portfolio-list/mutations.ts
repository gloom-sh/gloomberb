import type { AppConfig } from "../../../types/config";
import type { Portfolio, TickerPosition, TickerRecord } from "../../../types/ticker";
import { resolveCurrencyUnit } from "../../../utils/currency-units";
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

/** A plain ISO code in major units (AUD), else null: pence-type units and free text never total a portfolio. */
function majorCurrencyCode(value: string | undefined): string | null {
  const raw = value?.trim() ?? "";
  return /^[A-Z]{3}$/.test(raw) && resolveCurrencyUnit(raw).divisor === 1 ? raw : null;
}

/** The currencies of a portfolio's open positions, as entered (or the listing's when a position has none). */
function openPositionCurrencies(portfolioId: string, tickers: Iterable<TickerRecord>): Set<string> {
  const currencies = new Set<string>();
  for (const ticker of tickers) {
    for (const position of ticker.metadata.positions) {
      if (position.portfolio !== portfolioId || position.shares === 0) continue;
      currencies.add((position.currency || ticker.metadata.currency || "").trim());
    }
  }
  return currencies;
}

export function hasOpenPortfolioPositions(portfolioId: string, tickers: Iterable<TickerRecord>): boolean {
  return openPositionCurrencies(portfolioId, tickers).size > 0;
}

/**
 * Whether a manual portfolio's currency follows its holdings. Only with the
 * default USD base: a base currency the user chose is what manual portfolios
 * total in. Team portfolios keep the currency the team gave them.
 */
function takesHoldingsCurrency(config: AppConfig, portfolio: Portfolio): boolean {
  return isManualPortfolio(portfolio) && !portfolio.teamId && config.baseCurrency.trim().toUpperCase() === "USD";
}

function withPortfolioCurrency(config: AppConfig, portfolioId: string, currency: string): AppConfig {
  return {
    ...config,
    portfolios: config.portfolios.map((portfolio) => (portfolio.id === portfolioId ? { ...portfolio, currency } : portfolio)),
  };
}

/**
 * The first position set in a manual portfolio decides its currency, so ASX
 * shares bought in AUD total in AUD and later holdings convert into it. Call
 * only when the portfolio had no open positions before this one. Null when
 * nothing changes.
 */
export function adoptFirstPositionCurrency(config: AppConfig, portfolioId: string, positionCurrency: string): AppConfig | null {
  const portfolio = config.portfolios.find((entry) => entry.id === portfolioId);
  const currency = majorCurrencyCode(positionCurrency);
  if (!portfolio || !currency || portfolio.currency === currency || !takesHoldingsCurrency(config, portfolio)) return null;
  return withPortfolioCurrency(config, portfolioId, currency);
}

/**
 * Once per install, for portfolios entered before the first position set the
 * currency: a manual portfolio still on USD whose open positions are all in
 * one other currency (ASX shares in AUD) takes that currency. Records that it
 * ran, so later changes in holdings never move a portfolio's currency.
 */
export function adoptHeldPortfolioCurrencies(config: AppConfig, tickers: Iterable<TickerRecord>): AppConfig {
  if (config.portfolioCurrenciesAdopted) return config;
  const records = [...tickers];
  let next: AppConfig = { ...config, portfolioCurrenciesAdopted: true };
  for (const portfolio of config.portfolios) {
    if (portfolio.currency !== "USD" || !takesHoldingsCurrency(config, portfolio)) continue;
    const held = [...openPositionCurrencies(portfolio.id, records)];
    const currency = held.length === 1 ? majorCurrencyCode(held[0]) : null;
    if (currency && currency !== "USD") next = withPortfolioCurrency(next, portfolio.id, currency);
  }
  return next;
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
