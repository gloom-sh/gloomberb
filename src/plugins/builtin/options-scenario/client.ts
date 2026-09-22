import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef, OptionsRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { daysToExpiryFrom } from "../options-calculator/model";
import { surfaceTreasuryRate } from "../vol-surface/model";
import { optionMid } from "../shared/volatility";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { parseLegs, validatePosition, type ScenarioControls, type ScenarioLeg, type ScenarioPosition } from "./model";

export interface ScenarioMarketSnapshot {
  symbol: string;
  exchange?: string;
  spot: number | null;
  currency: string;
  asOf: number;
  chain: OptionsChain | null;
  expirationDates: number[];
  rate: number | null;
  dividendYield: number | null;
  source: string | null;
  underlyingQuote: Quote | null;
  rateAsOf: string[];
  warnings: string[];
}

export interface ScenarioLoaderDependencies {
  loadQuote(instrument: InstrumentRef, options?: { forceRefresh?: boolean }): Promise<QueryEntry<Quote>>;
  loadSnapshot(instrument: InstrumentRef, options?: { forceRefresh?: boolean }): Promise<QueryEntry<TickerFinancials>>;
  loadOptions(request: OptionsRequest, options?: { forceRefresh?: boolean }): Promise<QueryEntry<OptionsChain>>;
  loadYieldCurve(): Promise<YieldPoint[]>;
  now?: () => number;
}

export function createScenarioDependencies(
  marketData?: DataProvider,
  cloudApi: { getCloudYieldCurve(): Promise<YieldPoint[]> } = apiClient,
): ScenarioLoaderDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  const unavailable = () => Promise.reject(new Error("Market data coordinator unavailable"));
  return {
    loadQuote: (instrument, options) => coordinator?.loadQuote(instrument, options) ?? unavailable(),
    loadSnapshot: (instrument, options) => coordinator?.loadSnapshot(instrument, options) ?? unavailable(),
    loadOptions: (request, options) => coordinator?.loadOptions(request, options) ?? unavailable(),
    loadYieldCurve: () => cloudApi.getCloudYieldCurve(),
  };
}

export interface ScenarioMarketRequest {
  instrument: InstrumentRef;
  expiration?: number;
  /** A typed position can use a different valuation tenor from the chain picker. */
  rateExpiration?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const symbolMatches = (actual: string | undefined, expected: string) => actual?.trim().toUpperCase() === expected;
const abortError = () => new DOMException("Scenario load was cancelled", "AbortError");

/** Stop this consumer without cancelling a chain request shared with OMON. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Quotes, fundamentals and the selected chain fail independently. Missing inputs remain missing. */
export async function loadScenarioMarket(
  request: ScenarioMarketRequest,
  dependencies: ScenarioLoaderDependencies = createScenarioDependencies(),
): Promise<ScenarioMarketSnapshot> {
  if (request.signal?.aborted) throw abortError();
  const now = dependencies.now?.() ?? Date.now();
  const symbol = request.instrument.symbol.trim().toUpperCase();
  const options = { forceRefresh: request.forceRefresh };
  const warnings: string[] = [];
  const settled = await abortable(Promise.allSettled([
    dependencies.loadQuote(request.instrument, options),
    dependencies.loadSnapshot(request.instrument, options),
    dependencies.loadOptions({ instrument: request.instrument, expirationDate: request.expiration }, options),
    dependencies.loadYieldCurve(),
  ]), request.signal);
  if (request.signal?.aborted) throw abortError();
  const [quoteResult, financialsResult, chainResult, curveResult] = settled;
  const entry = <T>(result: PromiseSettledResult<QueryEntry<T>>, label: string): QueryEntry<T> | null => {
    if (result.status === "rejected") { warnings.push(`${label}: ${message(result.reason)}`); return null; }
    if (result.value.error) warnings.push(`${label}: ${result.value.error.message}`);
    return result.value;
  };
  const quoteEntry = entry(quoteResult, "Underlying quote");
  const quote = quoteEntry ? resolveEntryValue(quoteEntry) : null;
  const quoteCurrent = quote != null && symbolMatches(quote.symbol, symbol) && positive(quote.price)
    && !quote.stale && !quoteEntry?.error && (quoteEntry?.staleAt == null || quoteEntry.staleAt > now);
  if (quote && !symbolMatches(quote.symbol, symbol)) warnings.push("Underlying quote does not match the requested ticker");
  else if (!quoteCurrent) warnings.push("Current underlying quote unavailable");
  const financialsEntry = entry(financialsResult, "Dividend yield");
  const financials = financialsEntry ? resolveEntryValue(financialsEntry) : null;
  const fundamentals = financials?.fundamentals;
  const financialsSymbol = financials?.quote?.symbol ?? financials?.quoteMetadata?.symbol;
  const validDividend = symbolMatches(financialsSymbol, symbol) && !fundamentals?.stale && !financialsEntry?.error
    && typeof fundamentals?.dividendYield === "number" && Number.isFinite(fundamentals.dividendYield) && fundamentals.dividendYield >= 0;
  if (!validDividend) warnings.push("Dividend yield unavailable; supply an explicit assumption");
  const chainEntry = entry(chainResult, "Options chain");
  let chain = chainEntry ? resolveEntryValue(chainEntry) : null;
  if (chain && !symbolMatches(chain.underlyingSymbol, symbol)) {
    warnings.push("Options chain does not match the requested ticker"); chain = null;
  }
  const expirationDates = [...new Set((chain?.expirationDates ?? []).filter((expiration) =>
    positive(expiration) && daysToExpiryFrom(expiration, now) > 0))].sort((a, b) => a - b);
  if (chain && request.expiration != null && (!expirationDates.includes(request.expiration)
    || [...chain.calls, ...chain.puts].some((contract) => contract.expiration !== request.expiration))) {
    warnings.push("Selected expiration unavailable in the returned options chain"); chain = null;
  }
  if (!chain) warnings.push("Options chain unavailable");
  else if (chainEntry?.error || (chainEntry?.staleAt != null && chainEntry.staleAt <= now)) warnings.push("Options chain is stale");
  const rateExpiration = request.rateExpiration ?? request.expiration ?? expirationDates[0];
  const curve = curveResult.status === "fulfilled" ? curveResult.value : [];
  if (curveResult.status === "rejected") warnings.push(`Treasury: ${message(curveResult.reason)}`);
  const rate = surfaceTreasuryRate(curve, rateExpiration == null ? NaN : daysToExpiryFrom(rateExpiration, now) / 365);
  warnings.push(...rate.warnings);
  return {
    symbol, exchange: request.instrument.exchange, spot: quoteCurrent ? quote!.price : null, currency: quoteCurrent ? quote!.currency : "",
    asOf: quoteCurrent && positive(quote!.lastUpdated) ? quote!.lastUpdated : now,
    chain, expirationDates, rate: rate.rate, dividendYield: validDividend ? fundamentals!.dividendYield! : null,
    source: quoteCurrent ? quoteEntry?.source ?? quote!.providerId ?? null : null,
    underlyingQuote: quoteCurrent ? quote : null, rateAsOf: rate.asOf, warnings: [...new Set(warnings)],
  };
}

function supplied(value: unknown): boolean { return value != null && value !== ""; }

function numericSetting(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  if (!supplied(value)) return undefined;
  if ((typeof value !== "string" && typeof value !== "number")
    || (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))
    || !Number.isFinite(Number(value))) throw new Error(`${key} must be a finite number`);
  return Number(value);
}

/** Dates are explicit UTC ISO timestamps or UTC calendar dates. Milliseconds are accepted in persisted state. */
function dateSetting(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  if (!supplied(value)) return undefined;
  if (typeof value === "number" && positive(value) && Number.isFinite(new Date(value).getTime())) return value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/.test(value)) {
    throw new Error(`${key} must be YYYY-MM-DD or an ISO timestamp ending in Z`);
  }
  const date = Date.parse(value);
  if (!positive(date) || new Date(date).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error(`${key} is not a valid date`);
  return date;
}

/** Pane settings and CLI flags use percentage units; all model fields use decimals. */
export function scenarioPositionFromSettings(
  settings: Record<string, unknown>, market?: ScenarioMarketSnapshot | null,
): ScenarioPosition | null {
  const target = parsePublicTickerKey(String(settings.symbol ?? market?.symbol ?? ""));
  const symbol = target.symbol;
  const exchange = target.exchange ?? (typeof settings.exchange === "string" ? canonicalExchange(settings.exchange) : undefined);
  const exchangeMismatch = (other: string | undefined) => !!exchange && !!other && canonicalExchange(other) !== canonicalExchange(exchange);
  if (settings.seedPosition && typeof settings.seedPosition === "object") {
    const seed = settings.seedPosition as ScenarioPosition;
    const error = validatePosition(seed);
    if (error) throw new Error(error);
    const seeded = parsePublicTickerKey(seed.symbol);
    if (seeded.symbol !== symbol || exchangeMismatch(seeded.exchange ?? seed.exchange)) throw new Error("Saved position does not match the requested ticker");
    return { ...seed, symbol, exchange: exchange ?? seeded.exchange ?? seed.exchange, legs: seed.legs.map((leg) => ({ ...leg })) };
  }
  if (market && (market.symbol !== symbol || exchangeMismatch(market.exchange))) throw new Error("Market snapshot does not match the requested ticker");
  const spot = numericSetting(settings, "spot") ?? market?.spot;
  const legText = typeof settings.legs === "string" ? settings.legs : "";
  let legs = legText.trim() ? parseLegs(legText) : [];
  if (!legs.length && supplied(settings.strategy)) {
    if (settings.strategy !== "vertical" && settings.strategy !== "straddle") throw new Error("strategy must be vertical or straddle");
    if (!market?.chain || market.warnings.includes("Options chain is stale")) throw new Error("A current options chain is required to seed a strategy");
    if (spot == null) throw new Error("A current underlying price or explicit --spot is required");
    legs = scenarioStrategyLegs(market.chain, spot, settings.strategy);
  }
  if (!legs.length) return null;
  const rateValue = numericSetting(settings, "rate");
  const dividendValue = numericSetting(settings, "dividendYield");
  const rate = rateValue == null ? market?.rate : rateValue / 100;
  const dividendYield = dividendValue == null ? market?.dividendYield : dividendValue / 100;
  if (spot == null) throw new Error("A current underlying price or explicit --spot is required");
  if (rate == null) throw new Error("Treasury rate unavailable; supply --rate as an annual percentage");
  if (dividendYield == null) throw new Error("Dividend yield unavailable; supply --dividend-yield as an annual percentage");
  const position: ScenarioPosition = {
    symbol, exchange: exchange ?? market?.exchange,
    currency: String(settings.currency ?? market?.currency ?? "").trim().toUpperCase() || "UNKNOWN",
    spot, rate, dividendYield, asOf: dateSetting(settings, "asOf") ?? market?.asOf ?? Date.now(), legs,
  };
  const error = validatePosition(position);
  if (error) throw new Error(error);
  if (supplied(settings.strategy) && market?.chain) {
    const contracts = [...market.chain.calls, ...market.chain.puts].filter((contract) => legs.some((leg) => leg.id === contract.contractSymbol));
    if (contracts.some((contract) => contract.currency && contract.currency !== position.currency)) throw new Error("Strategy currency differs from the underlying quote currency");
  }
  return position;
}

/** An explicit strategy request uses only two-sided quotes and the provider's observed IV. */
function scenarioStrategyLegs(chain: OptionsChain, spot: number, strategy: "vertical" | "straddle"): ScenarioLeg[] {
  const eligible = (contracts: OptionsChain["calls"]) => contracts.filter((contract) =>
    positive(contract.strike) && optionMid(contract) != null && positive(contract.impliedVolatility) && contract.impliedVolatility <= 5);
  const calls = eligible(chain.calls).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const puts = eligible(chain.puts);
  const first = calls.find((call) => strategy === "vertical"
    ? calls.some((other) => other.expiration === call.expiration && other.strike > call.strike)
    : puts.some((put) => put.expiration === call.expiration && put.strike === call.strike));
  if (!first) throw new Error("The selected chain has no complete quoted strategy with usable IV");
  const second = strategy === "vertical"
    ? calls.filter((call) => call.expiration === first.expiration && call.strike > first.strike).sort((a, b) => a.strike - b.strike)[0]!
    : puts.find((put) => put.expiration === first.expiration && put.strike === first.strike)!;
  if (first.currency !== second.currency) throw new Error("Strategy quote currencies differ");
  return [first, second].map((contract, index) => ({
    id: contract.contractSymbol, side: index === 1 && strategy === "straddle" ? "put" : "call",
    quantity: index === 1 && strategy === "vertical" ? -1 : 1, strike: contract.strike,
    expiration: contract.expiration, price: optionMid(contract)!, volatility: contract.impliedVolatility, multiplier: 100,
  }));
}

export function scenarioControlsFromSettings(settings: Record<string, unknown>, position: ScenarioPosition): ScenarioControls {
  const volShift = (numericSetting(settings, "volShift") ?? 0) / 100;
  const spotRange = (numericSetting(settings, "spotRange") ?? 30) / 100;
  if (volShift < -5 || volShift > 5) throw new Error("volShift must be between -500 and 500 percentage points");
  if (spotRange <= 0 || spotRange > 3) throw new Error("spotRange must be greater than 0 and at most 300 percent");
  return { date: dateSetting(settings, "date") ?? position.asOf, volShift, spotRange };
}
