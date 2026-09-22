import type { Portfolio, TickerRecord } from "../../../types/ticker";
import type { ScenarioPosition } from "../options-scenario/model";
import { scenarioValue, validatePosition } from "../options-scenario/model";
import {
  createScenarioDependencies,
  loadScenarioMarket,
  type ScenarioLoaderDependencies,
} from "../options-scenario/client";
import { createGloomberbCloudProvider } from "../../../sources/gloomberb-cloud";
import { canonicalExchange } from "../../../utils/exchanges";

export interface PortfolioOptionBook {
  scope: "imported" | "broker-matched";
  positions: ScenarioPosition[];
  warnings: string[];
  complete: boolean;
}
let sharedCloudDependencies: ScenarioLoaderDependencies | null = null;
const cloudDependencies = () =>
  (sharedCloudDependencies ??= createScenarioDependencies(
    createGloomberbCloudProvider(),
  ));
const contractKey = (symbol: string) => symbol.replace(/\s/g, "").toUpperCase();
/** Match the exact broker option identity. No adjusted multiplier or underlying is guessed. */
export async function loadPortfolioOptionBook(
  tickers: readonly TickerRecord[],
  portfolio: Portfolio,
  dependencies: ScenarioLoaderDependencies = cloudDependencies(),
): Promise<PortfolioOptionBook> {
  const positions: ScenarioPosition[] = [],
    warnings: string[] = [];
  const requests = tickers.flatMap((ticker) =>
    ticker.metadata.positions
      .filter((row) => row.portfolio === portfolio.id && row.shares !== 0)
      .filter(
        (row) =>
          ["OPT", "OPTION", "OPTIONS", "FOP"].includes(ticker.metadata.assetCategory?.toUpperCase() ?? "") ||
          (ticker.metadata.broker_contracts ?? []).some(
            (contract) =>
              contract.secType === "OPT" &&
              contract.conId === row.brokerContractId,
          ),
      )
      .map((lot) => ({ ticker, lot })),
  );
  if (requests.length > 32)
    return {
      scope: "broker-matched",
      positions,
      warnings: ["Option Greeks support at most 32 broker lots"],
      complete: false,
    };
  const cache = new Map<string, ReturnType<typeof loadScenarioMarket>>();
  for (const { ticker, lot } of requests) {
    const label = ticker.metadata.ticker;
    try {
      const contracts = (ticker.metadata.broker_contracts ?? []).filter(
        (contract) =>
          contract.secType === "OPT" &&
          lot.brokerContractId != null &&
          contract.conId === lot.brokerContractId &&
          (!lot.brokerInstanceId ||
            contract.brokerInstanceId === lot.brokerInstanceId),
      );
      if (contracts.length !== 1)
        throw new Error("Exact broker contract identity is unavailable");
      const contract = contracts[0]!,
        expiry = contract.lastTradeDateOrContractMonth;
      const multiplier = Number(contract.multiplier);
      if (
        !contract.localSymbol ||
        !contract.symbol ||
        !expiry ||
        !/^\d{8}$/.test(expiry) ||
        !["C", "P"].includes(contract.right ?? "") ||
        !Number.isFinite(contract.strike) ||
        contract.strike! <= 0 ||
        !Number.isFinite(multiplier) ||
        multiplier <= 0 ||
        contract.currency !== portfolio.currency ||
        (lot.multiplier != null && lot.multiplier !== multiplier)
      )
        throw new Error(
          "Complete expiry, strike, side, multiplier and currency are required",
        );
      const expiration =
        Date.parse(
          `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6)}T00:00:00Z`,
        ) / 1000;
      const exchange = contract.primaryExchange
        ? canonicalExchange(contract.primaryExchange)
        : undefined;
      const key = `${contract.symbol}:${exchange ?? ""}:${expiration}`;
      if (!cache.has(key))
        cache.set(
          key,
          loadScenarioMarket(
            { instrument: { symbol: contract.symbol, exchange }, expiration },
            dependencies,
          ),
        );
      const market = await cache.get(key)!;
      if (
        market.spot == null ||
        market.rate == null ||
        market.dividendYield == null ||
        market.currency !== portfolio.currency ||
        !market.chain ||
        market.warnings.includes("Options chain is stale") ||
        !market.underlyingQuote?.lastUpdated ||
        Math.abs(
          (dependencies.now?.() ?? Date.now()) -
            market.underlyingQuote.lastUpdated,
        ) >
          4 * 86_400_000
      )
        throw new Error(
          "Fresh matching Cloud spot, chain, rate and dividend inputs are required",
        );
      const candidates = (
        contract.right === "C" ? market.chain.calls : market.chain.puts
      ).filter(
        (option) =>
          contractKey(option.contractSymbol) ===
            contractKey(contract.localSymbol!) &&
          option.expiration === expiration &&
          option.strike === contract.strike,
      );
      if (candidates.length !== 1)
        throw new Error("Broker option does not match one Cloud contract");
      const option = candidates[0]!;
      const chainAt = Date.parse(market.chain.asOf ?? "");
      if (
        option.currency !== portfolio.currency ||
        !Number.isFinite(chainAt) ||
        chainAt > (dependencies.now?.() ?? Date.now()) + 300_000 ||
        (dependencies.now?.() ?? Date.now()) - chainAt > 4 * 86_400_000
      )
        throw new Error("Option currency or source timestamp is unverified");
      if (
        !Number.isFinite(option.impliedVolatility) ||
        option.impliedVolatility <= 0
      )
        throw new Error("Contract implied volatility unavailable");
      const position: ScenarioPosition = {
        symbol: market.symbol,
        exchange,
        currency: market.currency,
        spot: market.spot,
        rate: market.rate,
        dividendYield: market.dividendYield,
        asOf: market.asOf,
        legs: [
          {
            id: String(contract.conId),
            side: contract.right === "C" ? "call" : "put",
            quantity: lot.side === "short" ? -Math.abs(lot.shares) : lot.shares,
            multiplier,
            strike: option.strike,
            expiration,
            price: 0,
            volatility: option.impliedVolatility,
          },
        ],
      };
      const error = validatePosition(position);
      if (error) throw new Error(error);
      positions.push(position);
    } catch (error) {
      warnings.push(
        `${label}: ${error instanceof Error ? error.message : "Option inputs unavailable"}`,
      );
    }
  }
  return {
    scope: "broker-matched",
    positions,
    warnings,
    complete: positions.length === requests.length,
  };
}
export function portfolioOptionGreeks(
  book: PortfolioOptionBook,
  currency: string,
  now = Date.now(),
) {
  const rows = book.positions.map((position) => {
    const error = validatePosition(position);
    if (
      error ||
      position.currency !== currency ||
      position.asOf > now ||
      now - position.asOf > 4 * 86_400_000
    ) {
      return {
        symbol: position.symbol,
        asOf: position.asOf,
        currency: position.currency,
        deltaDollars: null,
        gammaOnePercent: null,
        vega: null,
        theta: null,
        rho: null,
        error:
          error ??
          (position.currency !== currency
            ? "Option currency differs"
            : "Option input snapshot is stale or future-dated"),
      };
    }
    const value = scenarioValue(position, position.spot, position.asOf, 0);
    return {
      symbol: position.symbol,
      asOf: position.asOf,
      currency: position.currency,
      deltaDollars: value.delta * position.spot,
      gammaOnePercent: 0.5 * value.gamma * (0.01 * position.spot) ** 2,
      vega: value.vegaPerPoint,
      theta: value.thetaPerDay,
      rho: value.rhoPerPoint,
      error: null,
    };
  });
  const complete =
    book.complete && rows.length > 0 && rows.every((row) => !row.error);
  const total = complete
    ? {
        deltaDollars: rows.reduce((sum, row) => sum + row.deltaDollars!, 0),
        gammaOnePercent: rows.reduce(
          (sum, row) => sum + row.gammaOnePercent!,
          0,
        ),
        vega: rows.reduce((sum, row) => sum + row.vega!, 0),
        theta: rows.reduce((sum, row) => sum + row.theta!, 0),
        rho: rows.reduce((sum, row) => sum + row.rho!, 0),
      }
    : null;
  return {
    scope: book.scope,
    rows,
    total,
    complete,
    warnings: [
      ...book.warnings,
      ...rows.flatMap((row) =>
        row.error ? [`${row.symbol}: ${row.error}`] : [],
      ),
    ],
  };
}
