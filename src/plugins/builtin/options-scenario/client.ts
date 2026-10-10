import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef, OptionsRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { expiryIsoDate, findListedExpiry, missingExpiryText } from "../../../utils/option-expiry";
import { surfaceTreasuryRate } from "../vol-surface/model";
import { daysToExpiryFrom, extractImpliedForward, optionMid, solveImpliedVolatility } from "../shared/volatility";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { parseLegs, scenarioCurrency, validatePosition, type ScenarioControls, type ScenarioLeg, type ScenarioPosition } from "./model";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";

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
  /** Why the requested expiry has no chain, naming the listed dates nearest it. */
  missingExpiry?: string;
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

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const symbolMatches = (actual: string | undefined, expected: string) => actual?.trim().toUpperCase() === expected;
const CANCELLED = "Scenario load was cancelled";

/** Quotes, fundamentals and the selected chain fail independently. Missing inputs remain missing. */
export async function loadScenarioMarket(
  request: ScenarioMarketRequest,
  dependencies: ScenarioLoaderDependencies = createScenarioDependencies(),
): Promise<ScenarioMarketSnapshot> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const now = dependencies.now?.() ?? Date.now();
  const symbol = request.instrument.symbol.trim().toUpperCase();
  const options = { forceRefresh: request.forceRefresh };
  const warnings: string[] = [];
  const settled = await abortable(Promise.allSettled([
    dependencies.loadQuote(request.instrument, options),
    dependencies.loadSnapshot(request.instrument, options),
    dependencies.loadOptions({ instrument: request.instrument, expirationDate: request.expiration }, options),
    dependencies.loadYieldCurve(),
  ]), request.signal, CANCELLED);
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const [quoteResult, financialsResult, chainResult, curveResult] = settled;
  const entry = <T>(result: PromiseSettledResult<QueryEntry<T>>, label: string): QueryEntry<T> | null => {
    if (result.status === "rejected") { warnings.push(`${label}: ${errorMessage(result.reason)}`); return null; }
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
  let chainEntry = entry(chainResult, "Options chain");
  let chain = chainEntry ? resolveEntryValue(chainEntry) : null;
  if (chain && !symbolMatches(chain.underlyingSymbol, symbol)) {
    warnings.push("Options chain does not match the requested ticker"); chain = null;
  }
  const expirationDates = [...new Set((chain?.expirationDates ?? []).filter((expiration) =>
    positive(expiration) && daysToExpiryFrom(expiration, now) > 0))].sort((a, b) => a - b);
  // A typed date is that day's UTC midnight; the chain's own stamp for the
  // expiry is matched by calendar date, as OMON matches it.
  const listedExpiration = request.expiration == null ? undefined : findListedExpiry(request.expiration, expirationDates);
  const onExpiry = (value: OptionsChain, expiration: number) => [...value.calls, ...value.puts]
    .every((contract) => expiryIsoDate(contract.expiration) === expiryIsoDate(expiration));
  if (chain && listedExpiration != null && listedExpiration !== request.expiration && !chain.calls.length && !chain.puts.length) {
    // A source that keys chains by its exact stamp answered the midnight request empty.
    chainEntry = await abortable(dependencies.loadOptions({ instrument: request.instrument, expirationDate: listedExpiration }, options)
      .catch((error: unknown) => { warnings.push(`Options chain: ${errorMessage(error)}`); return null; }), request.signal, CANCELLED);
    if (request.signal?.aborted) throw abortError(CANCELLED);
    if (chainEntry?.error) warnings.push(`Options chain: ${chainEntry.error.message}`);
    chain = chainEntry ? resolveEntryValue(chainEntry) : null;
  }
  let missingExpiry: string | undefined;
  if (chain && request.expiration != null && listedExpiration == null) {
    missingExpiry = sentence(missingExpiryText(request.expiration, expirationDates, symbol));
    warnings.push(missingExpiry); chain = null;
  } else if (chain && listedExpiration != null && !onExpiry(chain, listedExpiration)) {
    warnings.push("Selected expiration unavailable in the returned options chain"); chain = null;
  }
  if (!chain) warnings.push("Options chain unavailable");
  else if (chainEntry?.error || (chainEntry?.staleAt != null && chainEntry.staleAt <= now)) warnings.push("Options chain is stale");
  const rateExpiration = request.rateExpiration ?? request.expiration ?? expirationDates[0];
  const curve = curveResult.status === "fulfilled" ? curveResult.value : [];
  if (curveResult.status === "rejected") warnings.push(`Treasury: ${errorMessage(curveResult.reason)}`);
  const rate = surfaceTreasuryRate(curve, rateExpiration == null ? NaN : daysToExpiryFrom(rateExpiration, now) / 365);
  warnings.push(...rate.warnings);
  // A currency does not go stale with its quote: the listing's quote, its snapshot, or its contracts name it.
  const currency = [symbolMatches(quote?.symbol, symbol) ? quote?.currency : undefined,
    symbolMatches(financialsSymbol, symbol) ? financials?.quote?.currency : undefined,
    chain?.calls[0]?.currency, chain?.puts[0]?.currency].find((value) => !!value?.trim())?.trim().toUpperCase() ?? "";
  return {
    symbol, exchange: request.instrument.exchange, spot: quoteCurrent ? quote!.price : null, currency,
    asOf: quoteCurrent && positive(quote!.lastUpdated) ? quote!.lastUpdated : now,
    chain, expirationDates, rate: rate.rate, dividendYield: validDividend ? fundamentals!.dividendYield! : null,
    source: quoteCurrent ? quoteEntry?.source ?? quote!.providerId ?? null : null,
    underlyingQuote: quoteCurrent ? quote : null, rateAsOf: rate.asOf, warnings: [...new Set(warnings)],
    ...(missingExpiry ? { missingExpiry } : {}),
  };
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

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
  const whatIfSpot = numericSetting(settings, "spot");
  let spot = whatIfSpot ?? market?.spot;
  const rateValue = numericSetting(settings, "rate");
  const dividendValue = numericSetting(settings, "dividendYield");
  const rate = rateValue == null ? market?.rate : rateValue / 100;
  const dividendYield = dividendValue == null ? market?.dividendYield : dividendValue / 100;
  const legText = typeof settings.legs === "string" ? settings.legs : "";
  let legs = legText.trim() ? parseLegs(legText) : [];
  if (!legs.length && supplied(settings.strategy)) {
    if (settings.strategy !== "vertical" && settings.strategy !== "straddle") throw new Error("strategy must be vertical or straddle");
    if (!market?.chain || market.warnings.includes("Options chain is stale")) {
      throw new Error(market?.missingExpiry ?? "A current options chain is required to seed a strategy");
    }
    if (spot == null) throw new Error("A current underlying price or explicit --spot is required");
    // Leg IVs are solved at the market's own spot and time, never at a what-if override.
    const pricing = market.spot != null && rate != null ? { spot: market.spot, asOf: market.asOf, rate } : null;
    const seeded = scenarioStrategyLegs(market.chain, spot, settings.strategy, pricing);
    legs = seeded.legs;
    // Mids priced off the parity forward are worth their cost only at the spot
    // that forward implies on the scenario's own rate and dividend yield. The
    // last print can sit away from it when the quotes are older (the close's
    // chain against an after-hours print), so the origin starts there and the
    // print is a what-if from it. A typed spot is a what-if and is kept.
    if (whatIfSpot == null && seeded.parity && rate != null && dividendYield != null) {
      spot = seeded.parity.forward * Math.exp(-(rate - dividendYield) * seeded.parity.daysToExpiry / 365);
    }
  }
  if (!legs.length) return null;
  if (spot == null) throw new Error("A current underlying price or explicit --spot is required");
  if (rate == null) throw new Error("Treasury rate unavailable; supply --rate as an annual percentage");
  if (dividendYield == null) throw new Error("Dividend yield unavailable; supply --dividend-yield as an annual percentage");
  const position: ScenarioPosition = {
    symbol, exchange: exchange ?? market?.exchange,
    currency: scenarioCurrency(settings.currency, market?.currency, exchange ?? market?.exchange),
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

interface StrategyPricing { spot: number; asOf: number; rate: number }

const usableVolatility = (value: unknown): value is number => positive(value) && value <= 5;

interface StrategyParity { forward: number; daysToExpiry: number }

/**
 * An explicit strategy request uses only two-sided quotes and enters each leg
 * at its quote midpoint, so each leg takes the IV that midpoint implies against
 * the expiry's put-call parity forward, with the time left at the market
 * timestamp OSA values at. This holds even when the chain carries a provider
 * IV measured at another time (a same-day IV solved when the chain was served,
 * hours after the after-hours print OSA values at). The forward comes from the
 * same quotes, so a spot that moved after they were taken (an after-hours or
 * pre-market print against the close's chain) does not skew the call against
 * the put. A leg whose midpoint cannot be solved (a spot too far from every
 * parity forward to trust the quotes, or a midpoint below intrinsic value)
 * keeps a usable provider IV, and without one it is not eligible. `parity` is
 * the forward a seeded leg was solved against, so the caller can start the
 * scenario at the spot it implies.
 */
function scenarioStrategyLegs(
  chain: OptionsChain, spot: number, strategy: "vertical" | "straddle", pricing: StrategyPricing | null,
): { legs: ScenarioLeg[]; parity: StrategyParity | null } {
  const parity = new Map<number, StrategyParity | null>();
  const parityFor = (expiration: number) => {
    if (!pricing) return null;
    if (!parity.has(expiration)) {
      const daysToExpiry = daysToExpiryFrom(expiration, pricing.asOf);
      const { forward } = extractImpliedForward(chain.calls.filter((call) => call.expiration === expiration),
        chain.puts.filter((put) => put.expiration === expiration), pricing.spot, daysToExpiry / 365, pricing.rate,
        chain.underlyingSymbol);
      parity.set(expiration, forward == null ? null : { forward, daysToExpiry });
    }
    return parity.get(expiration)!;
  };
  const quoted = (contracts: OptionsChain["calls"], side: ScenarioLeg["side"]) => contracts.flatMap((contract) => {
    const mid = optionMid(contract);
    if (!positive(contract.strike) || mid == null) return [];
    const expiry = parityFor(contract.expiration);
    // q=r turns the spot pricer into discounted forward pricing.
    const volatility = expiry ? solveImpliedVolatility({ side, spot: expiry.forward, strike: contract.strike,
      daysToExpiry: expiry.daysToExpiry, rate: pricing!.rate, dividendYield: pricing!.rate }, mid).volatility : null;
    if (usableVolatility(volatility)) return [{ contract, mid, volatility, solved: true }];
    return usableVolatility(contract.impliedVolatility) ? [{ contract, mid, volatility: contract.impliedVolatility, solved: false }] : [];
  });
  const calls = quoted(chain.calls, "call").sort((a, b) => Math.abs(a.contract.strike - spot) - Math.abs(b.contract.strike - spot));
  const puts = quoted(chain.puts, "put");
  const first = calls.find(({ contract: call }) => strategy === "vertical"
    ? calls.some(({ contract: other }) => other.expiration === call.expiration && other.strike > call.strike)
    : puts.some(({ contract: put }) => put.expiration === call.expiration && put.strike === call.strike));
  if (!first) throw new Error("The selected chain has no complete quoted strategy with usable IV");
  const second = strategy === "vertical"
    ? calls.filter(({ contract }) => contract.expiration === first.contract.expiration && contract.strike > first.contract.strike)
      .sort((a, b) => a.contract.strike - b.contract.strike)[0]!
    : puts.find(({ contract }) => contract.expiration === first.contract.expiration && contract.strike === first.contract.strike)!;
  if (first.contract.currency !== second.contract.currency) throw new Error("Strategy quote currencies differ");
  const legs = [first, second].map(({ contract, mid, volatility, solved }, index): ScenarioLeg => ({
    id: contract.contractSymbol, side: index === 1 && strategy === "straddle" ? "put" : "call",
    quantity: index === 1 && strategy === "vertical" ? -1 : 1, strike: contract.strike,
    expiration: contract.expiration, price: mid, volatility, multiplier: 100,
    ...(solved ? { volatilitySource: "mid" as const } : {}),
  }));
  return { legs, parity: first.solved || second.solved ? parityFor(first.contract.expiration) : null };
}

export function scenarioControlsFromSettings(settings: Record<string, unknown>, position: ScenarioPosition): ScenarioControls {
  const volShift = (numericSetting(settings, "volShift") ?? 0) / 100;
  const spotRange = (numericSetting(settings, "spotRange") ?? 30) / 100;
  if (volShift < -5 || volShift > 5) throw new Error("volShift must be between -500 and 500 percentage points");
  if (spotRange <= 0 || spotRange > 3) throw new Error("spotRange must be greater than 0 and at most 300 percent");
  return { date: dateSetting(settings, "date") ?? position.asOf, volShift, spotRange };
}
