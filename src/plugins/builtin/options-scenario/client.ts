import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef, OptionsRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { DataProvider } from "../../../types/data-provider";
import type { CorporateActionsData, OptionsChain, Quote, TickerFinancials } from "../../../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { numberErrorMessage } from "../../../utils/decimal-comma";
import { expiryIsoDate, findListedExpiry, missingExpiryText } from "../../../utils/option-expiry";
import { surfaceTreasuryRate } from "../vol-surface/model";
import { daysToExpiryFrom, extractImpliedForward, optionDelta, optionMid, solveImpliedVolatility, valueOption } from "../shared/volatility";
import type { YieldPoint } from "../yield-curve/treasury-data";
import { parseLegs, scenarioCurrency, validatePosition, type ScenarioControls, type ScenarioLeg, type ScenarioPosition } from "./model";
import { loadModelDividendYield, type ModelDividendYield } from "../../../market-data/model-dividend-yield";
import { abortable, abortError } from "../../../utils/async-deadline";
import { extendedSession, modelSpotStamp, modelSpotStampVariants, type OptionModelSpot } from "../options/model-spot";
import { errorMessage } from "../../../utils/errors";
import { dateOptionError, dateOptionFormatsOr, readCalendarDate } from "../../../utils/calendar-date";

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
  /** Where `dividendYield` is from: the fundamentals, a distribution history with none paid, or one that stopped. Absent from older snapshots. */
  dividendYieldBasis?: ModelDividendYield["basis"] | null;
  /** The last distribution's ex-date of a dividend that stopped (basis `stopped`). */
  dividendLastPaid?: string | null;
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
  /** The distribution history, read when the fundamentals state no dividend yield or a forward one that may have stopped. */
  loadCorporateActions?(instrument: InstrumentRef): Promise<CorporateActionsData | null>;
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
    loadCorporateActions: (instrument) => coordinator?.loadCorporateActions(instrument) ?? unavailable(),
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
  const financialsSymbol = financials?.quote?.symbol ?? financials?.quoteMetadata?.symbol;
  const fundamentals = financials?.fundamentals;
  // Only a current yield stated for this symbol; else, as the options chain, 0 for a history with no dividend paid. Either way 0 for one that stopped.
  const stated = symbolMatches(financialsSymbol, symbol) && !fundamentals?.stale && !financialsEntry?.error
    ? fundamentals : null;
  const dividend = await loadModelDividendYield(stated, symbol,
    dependencies.loadCorporateActions ? () => dependencies.loadCorporateActions!(request.instrument) : null,
    { now, signal: request.signal }).catch((error: unknown) => {
    if (request.signal?.aborted) throw abortError(CANCELLED);
    throw error;
  });
  if (request.signal?.aborted) throw abortError(CANCELLED);
  if (!dividend) warnings.push("Dividend yield unavailable; supply an explicit assumption");
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
    chain, expirationDates, rate: rate.rate, dividendYield: dividend?.value ?? null, dividendYieldBasis: dividend?.basis ?? null,
    ...(dividend?.basis === "stopped" ? { dividendLastPaid: dividend.lastPaid ?? null } : {}),
    source: quoteCurrent ? quoteEntry?.source ?? quote!.providerId ?? null : null,
    underlyingQuote: quoteCurrent ? quote : null, rateAsOf: rate.asOf, warnings: [...new Set(warnings)],
    ...(missingExpiry ? { missingExpiry } : {}),
  };
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const cents = (value: number) => value.toFixed(2);

/**
 * What the scenario's spot is, in words, for the labels that name it: `typed`
 * for a what-if, `implied by option quotes` for a seeded strategy whose quote
 * mids imply another spot than the last print, else the last price and its
 * session (`pre-market`, `after hours`), or `input` without a market.
 */
export function scenarioSpotBasis(
  settings: Record<string, unknown>,
  position: Pick<ScenarioPosition, "spot" | "legs">,
  market: Pick<ScenarioMarketSnapshot, "spot" | "underlyingQuote"> | null | undefined,
): string {
  if (supplied(settings.spot)) return "typed";
  const marketSpot = market?.spot;
  if (marketSpot == null) return "input";
  if (position.legs.some((leg) => leg.volatilitySource === "mid") && cents(marketSpot) !== cents(position.spot)) return "implied by option quotes";
  return (market?.underlyingQuote ? extendedSession(market.underlyingQuote) : null) ?? "last price";
}

const EXTENDED_BASES: readonly string[] = ["pre-market", "after hours", "overnight"];

/**
 * A spot basis as the pane and report name it: an extended-session print with
 * its time, stamped as every options pane stamps its spot (`modelSpotStamp`),
 * `pre-market Wed 21 Oct 09:42 UTC`; any other basis as it is.
 */
export function scenarioSpotStamp(basis: string, observedAt: number): string {
  if (!EXTENDED_BASES.includes(basis)) return basis;
  return modelSpotStamp({ basis: "last", session: basis as OptionModelSpot["session"], observedAt }) ?? basis;
}

/** That stamp's shorter forms, longest first (`modelSpotStampVariants`): `pre-market 09:42 UTC`, `pre-market`. */
export function scenarioSpotStampVariants(basis: string, observedAt: number): string[] {
  if (!EXTENDED_BASES.includes(basis)) return [];
  return modelSpotStampVariants({ basis: "last", session: basis as OptionModelSpot["session"], observedAt });
}

function supplied(value: unknown): boolean { return value != null && value !== ""; }

/** A position typed whole: its legs and the spot, rate and dividend yield they are valued at, so no market data is read. */
export function suppliedScenarioInputs(settings: Record<string, unknown>): boolean {
  return !!settings.legs && ["spot", "rate", "dividendYield"].every((key) => supplied(settings[key]));
}

function numericSetting(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  if (!supplied(value)) return undefined;
  if ((typeof value !== "string" && typeof value !== "number")
    || (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))
    || !Number.isFinite(Number(value))) throw new Error(numberErrorMessage(`${key} must be a finite number`, value));
  return Number(value);
}

/** Dates are explicit UTC ISO timestamps or UTC calendar dates, written as a date option takes them. Milliseconds are accepted in persisted state. */
function dateSetting(settings: Record<string, unknown>, key: string): number | undefined {
  const value = settings[key];
  if (!supplied(value)) return undefined;
  if (typeof value === "number" && positive(value) && Number.isFinite(new Date(value).getTime())) return value;
  const day = typeof value === "string" ? readCalendarDate(value) : null;
  if (day) return Date.parse(`${day}T00:00:00Z`);
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/.test(value)) {
    throw new Error(dateOptionError(String(value), key === "asOf" ? "--as-of" : `--${key}`, {
      subject: key === "asOf" ? "a valuation date" : "a scenario date", formats: dateOptionFormatsOr("an ISO timestamp ending in Z"),
    }));
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
  const strike = numericSetting(settings, "strike");
  if (strike != null && !(strike > 0)) throw new Error("strike must be positive");
  if (strike != null && !supplied(settings.strategy)) throw new Error("strike picks the strike of --strategy; add --strategy put, csp, vertical or straddle");
  const delta = putDeltaSetting(settings);
  if (delta != null && strike != null) throw new Error("delta and strike each pick the put; give one of them");
  const collarStrikes = { put: numericSetting(settings, "putStrike"), call: numericSetting(settings, "callStrike") };
  if ((collarStrikes.put != null || collarStrikes.call != null) && settings.strategy !== "collar") {
    throw new Error("put-strike and call-strike pick a collar's strikes; add --strategy collar");
  }
  if (settings.strategy === "collar" && strike != null) throw new Error("A collar has two strikes; use --put-strike and --call-strike");
  for (const [side, value] of Object.entries(collarStrikes)) {
    if (value != null && !(value > 0)) throw new Error(`${side}-strike must be positive`);
  }
  if (collarStrikes.put != null && collarStrikes.call != null && collarStrikes.put >= collarStrikes.call) {
    throw new Error("A collar's put strike must be below its call strike");
  }
  const shares = sharesSetting(settings);
  // Typed legs buy the shares at the position's spot, a typed --spot when given. A seed buys them where its
  // quotes put the spot, else at the market's, and a typed --spot stays a what-if from there.
  let shareEntry: number | null | undefined;
  if (!legs.length && supplied(settings.strategy)) {
    if (!isScenarioStrategy(settings.strategy)) throw new Error("strategy must be vertical, straddle, put, csp or collar");
    if (!market?.chain || market.warnings.includes("Options chain is stale")) {
      throw new Error(market?.missingExpiry ?? "A current options chain is required to seed a strategy");
    }
    if (spot == null) throw new Error("A current underlying price or explicit --spot is required");
    // Leg IVs are solved at the market's own spot and time, never at a what-if override.
    const pricing = market.spot != null && rate != null ? { spot: market.spot, asOf: market.asOf, rate, dividendYield: dividendYield ?? 0 } : null;
    if (delta != null && !pricing) throw new Error("Choosing the put by delta needs the Treasury rate; supply --rate, or pick it with --strike");
    const seeded = scenarioStrategyLegs(market.chain, spot, settings.strategy, pricing, strike, collarStrikes, delta);
    legs = seeded.legs;
    shareEntry = market.spot;
    // Mids priced off the parity forward are worth their cost only at the spot
    // that forward implies on the scenario's own rate and dividend yield. The
    // last print can sit away from it when the quotes are older (the close's
    // chain against an after-hours print), so the origin starts there and the
    // print is a what-if from it. A typed spot is a what-if and is kept.
    if (seeded.parity && rate != null && dividendYield != null) {
      const implied = seeded.parity.forward * Math.exp(-(rate - dividendYield) * seeded.parity.daysToExpiry / 365);
      shareEntry = implied;
      if (whatIfSpot == null) spot = implied;
    }
  }
  if (!legs.length) return null;
  if (spot == null) throw new Error("A current underlying price or explicit --spot is required");
  if (rate == null) throw new Error("Treasury rate unavailable; supply --rate as an annual percentage");
  if (dividendYield == null) throw new Error("Dividend yield unavailable; supply --dividend-yield as an annual percentage");
  // A collar holds the shares its contracts cover unless --shares says otherwise; 0 drops them.
  const heldShares = shares ?? (settings.strategy === "collar"
    ? Math.max(0, ...legs.filter((leg) => leg.side === "put" && leg.quantity > 0).map((leg) => leg.quantity * leg.multiplier)) : 0);
  if (!Number.isSafeInteger(heldShares)) throw new Error("shares must be a whole number of shares");
  const position: ScenarioPosition = {
    symbol, exchange: exchange ?? market?.exchange,
    currency: scenarioCurrency(settings.currency, market?.currency, exchange ?? market?.exchange),
    spot, rate, dividendYield, asOf: dateSetting(settings, "asOf") ?? market?.asOf ?? Date.now(), legs,
    ...(heldShares ? { underlying: { quantity: heldShares, price: shareEntry ?? spot } } : {}),
  };
  const error = validatePosition(position);
  if (error) throw new Error(error);
  if (supplied(settings.strategy) && market?.chain) {
    const contracts = [...market.chain.calls, ...market.chain.puts].filter((contract) => legs.some((leg) => leg.id === contract.contractSymbol));
    if (contracts.some((contract) => contract.currency && contract.currency !== position.currency)) throw new Error("Strategy currency differs from the underlying quote currency");
  }
  return position;
}

/**
 * `--delta`: the put a csp or put seed sells or buys, by the absolute delta it
 * is nearest (0.30, or -0.30 as a put's own sign reads it); undefined when not set.
 */
function putDeltaSetting(settings: Record<string, unknown>): number | undefined {
  const value = numericSetting(settings, "delta");
  if (value == null) return undefined;
  if (settings.strategy !== "csp" && settings.strategy !== "put") throw new Error("delta picks the put of --strategy csp or put");
  const delta = Math.abs(value);
  if (!(delta > 0 && delta < 1)) throw new Error(`delta must be a put's delta between 0 and 1, such as 0.30; got ${String(settings.delta)}`);
  return delta;
}

/** `--shares`: a signed whole number of shares of the underlying, or undefined when not set. */
function sharesSetting(settings: Record<string, unknown>): number | undefined {
  const value = settings.shares;
  if (!supplied(value)) return undefined;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replaceAll(",", "") : "";
  if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`shares must be a whole number of shares, such as 100, or 0 for none; got "${String(value)}"`);
  }
  return Number(text);
}

/**
 * The seeds `--strategy` builds: a call vertical, a straddle, one long put, one
 * short put (a cash-secured put), or a collar (a long put and a short call on
 * one expiry, with the shares they cover).
 */
export const SCENARIO_STRATEGIES = ["vertical", "straddle", "put", "csp", "collar"] as const;
type ScenarioStrategy = typeof SCENARIO_STRATEGIES[number];
const isScenarioStrategy = (value: unknown): value is ScenarioStrategy => SCENARIO_STRATEGIES.includes(value as ScenarioStrategy);

interface StrategyPricing { spot: number; asOf: number; rate: number; dividendYield: number }

const usableVolatility = (value: unknown): value is number => positive(value) && value <= 5;

interface StrategyParity { forward: number; daysToExpiry: number }

/**
 * An explicit strategy request uses only two-sided quotes and enters each leg
 * at its quote midpoint, so each leg takes the IV that midpoint implies against
 * the expiry's put-call parity forward, with the time left at the market
 * timestamp OSA values at. This holds even when the chain carries a provider
 * IV measured at another time (a same-day IV solved at the close's quotes,
 * hours before the after-hours print OSA values at). The forward comes from the
 * same quotes, so a spot that moved after they were taken (an after-hours or
 * pre-market print against the close's chain) does not skew the call against
 * the put. A leg whose midpoint cannot be solved (a spot too far from every
 * parity forward to trust the quotes, or a midpoint below intrinsic value)
 * keeps a usable provider IV, and without one it is not eligible. `parity` is
 * the forward a seeded leg was solved against, so the caller can start the
 * scenario at the spot it implies.
 *
 * Each strategy is anchored at the strike nearest spot, or at `strike` when
 * one is given: a long put (a protective put), a short put (a cash-secured
 * put, sold at the midpoint like every seed), a call vertical from the anchor
 * to the next listed strike up, or a straddle at the anchor. A collar buys
 * the put at `collar.put` and sells the call at `collar.call` on the put's
 * expiry, each the quoted strike nearest 10% out of the money when omitted.
 * A put or csp seed given a `delta` takes the put whose spot delta, valued at
 * the IV its own midpoint implies, is nearest that delta's negative.
 */
function scenarioStrategyLegs(
  chain: OptionsChain, spot: number, strategy: ScenarioStrategy, pricing: StrategyPricing | null, strike?: number,
  collar: { put?: number; call?: number } = {}, delta?: number,
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
  const nearest = (a: { contract: { strike: number } }, b: { contract: { strike: number } }) =>
    Math.abs(a.contract.strike - spot) - Math.abs(b.contract.strike - spot);
  const anchored = ({ contract }: { contract: { strike: number } }) => strike == null || Math.abs(contract.strike - strike) < 1e-9;
  const calls = quoted(chain.calls, "call").sort(nearest);
  const puts = quoted(chain.puts, "put").sort(nearest);
  const missing = (candidates: { contract: { strike: number } }[], at = strike, what: string = strategy === "csp" ? "put to sell" : strategy) => {
    if (at == null) return new Error("The selected chain has no complete quoted strategy with usable IV");
    const listed = [...new Set(candidates.map(({ contract }) => contract.strike))]
      .sort((a, b) => Math.abs(a - at) - Math.abs(b - at)).slice(0, 4).sort((a, b) => a - b);
    return new Error(`The selected chain has no complete quoted ${what} at strike ${at} with usable IV`
      + (listed.length ? `; nearest quoted strikes: ${listed.join(", ")}` : ""));
  };
  if (strategy === "collar") return collarLegs(calls, puts, spot, collar, missing, parityFor);
  if (strategy === "put" || strategy === "csp") {
    const put = delta == null ? puts.find(anchored) : nearestDelta(puts, -delta, spot, pricing, parityFor);
    if (!put) throw missing(puts);
    return { legs: [{ id: put.contract.contractSymbol, side: "put", quantity: strategy === "csp" ? -1 : 1, strike: put.contract.strike,
      expiration: put.contract.expiration, price: put.mid, priceSource: "mid", volatility: put.volatility, multiplier: 100,
      ...(put.solved ? { volatilitySource: "mid" as const } : {}) }],
    parity: put.solved ? parityFor(put.contract.expiration) : null };
  }
  const first = calls.find((entry) => anchored(entry) && (strategy === "vertical"
    ? calls.some(({ contract: other }) => other.expiration === entry.contract.expiration && other.strike > entry.contract.strike)
    : puts.some(({ contract: put }) => put.expiration === entry.contract.expiration && put.strike === entry.contract.strike)));
  if (!first) throw missing(calls);
  const second = strategy === "vertical"
    ? calls.filter(({ contract }) => contract.expiration === first.contract.expiration && contract.strike > first.contract.strike)
      .sort((a, b) => a.contract.strike - b.contract.strike)[0]!
    : puts.find(({ contract }) => contract.expiration === first.contract.expiration && contract.strike === first.contract.strike)!;
  if (first.contract.currency !== second.contract.currency) throw new Error("Strategy quote currencies differ");
  const legs = [first, second].map(({ contract, mid, volatility, solved }, index): ScenarioLeg => ({
    id: contract.contractSymbol, side: index === 1 && strategy === "straddle" ? "put" : "call",
    quantity: index === 1 && strategy === "vertical" ? -1 : 1, strike: contract.strike,
    expiration: contract.expiration, price: mid, priceSource: "mid", volatility, multiplier: 100,
    ...(solved ? { volatilitySource: "mid" as const } : {}),
  }));
  return { legs, parity: first.solved || second.solved ? parityFor(first.contract.expiration) : null };
}

interface QuotedContract { contract: OptionsChain["calls"][number]; mid: number; volatility: number; solved: boolean }

/**
 * A put's spot delta at the IV it trades at: against the parity forward its
 * IV was solved on when it was (forward delta, carried to spot), else at the
 * seed's spot. Null when it cannot be valued.
 */
function quotedPutDelta(quoted: QuotedContract, spot: number, pricing: StrategyPricing | null, parity: StrategyParity | null): number | null {
  const { contract, volatility, solved } = quoted;
  if (!pricing) return null;
  if (solved && parity) {
    // On the forward, with the dividend yield set to the rate so it carries no drift, as the IV was solved.
    const forwardDelta = valueOption({ side: "put", spot: parity.forward, strike: contract.strike, daysToExpiry: parity.daysToExpiry,
      rate: pricing.rate, dividendYield: pricing.rate, volatility }).delta;
    return Number.isFinite(forwardDelta) ? forwardDelta * Math.exp((pricing.rate - pricing.dividendYield) * parity.daysToExpiry / 365) : null;
  }
  const years = daysToExpiryFrom(contract.expiration, pricing.asOf) / 365;
  return optionDelta({ spot, years, volatility, rate: pricing.rate, dividendYield: pricing.dividendYield }, contract.strike, "put");
}

/** The put whose delta is nearest `target` (negative, as a put's delta reads), the lower strike on a tie; null when none can be valued. */
function nearestDelta(
  puts: readonly QuotedContract[], target: number, spot: number, pricing: StrategyPricing | null,
  parityFor: (expiration: number) => StrategyParity | null,
): QuotedContract | null {
  let best: { put: QuotedContract; distance: number } | null = null;
  for (const put of puts) {
    const delta = quotedPutDelta(put, spot, pricing, put.solved ? parityFor(put.contract.expiration) : null);
    if (delta == null) continue;
    const distance = Math.abs(delta - target);
    if (!best || distance < best.distance - 1e-12 || (Math.abs(distance - best.distance) <= 1e-12 && put.contract.strike < best.put.contract.strike)) {
      best = { put, distance };
    }
  }
  return best?.put ?? null;
}

/** How far out of the money a collar's put and call sit when their strikes are not given. */
const COLLAR_DEFAULT_DISTANCE = 0.1;

/** A collar: one long put and one short call on the put's expiry, each at its quote midpoint. */
function collarLegs(
  calls: QuotedContract[], puts: QuotedContract[], spot: number, strikes: { put?: number; call?: number },
  missing: (candidates: QuotedContract[], at: number | undefined, what: string) => Error,
  parityFor: (expiration: number) => StrategyParity | null,
): { legs: ScenarioLeg[]; parity: StrategyParity | null } {
  const closest = (candidates: QuotedContract[], target: number) => candidates.toSorted((a, b) =>
    Math.abs(a.contract.strike - target) - Math.abs(b.contract.strike - target) || a.contract.strike - b.contract.strike);
  const at = (candidates: QuotedContract[], value: number) => candidates.filter(({ contract }) => Math.abs(contract.strike - value) < 1e-9);
  const put = strikes.put != null ? at(puts, strikes.put)[0]
    : closest(puts.filter(({ contract }) => strikes.call == null || contract.strike < strikes.call), spot * (1 - COLLAR_DEFAULT_DISTANCE))[0];
  if (!put) throw strikes.put != null ? missing(puts, strikes.put, "put to buy") : new Error("The selected chain has no complete quoted put to buy with usable IV");
  const sameExpiry = calls.filter(({ contract }) => contract.expiration === put.contract.expiration);
  const call = strikes.call != null ? at(sameExpiry, strikes.call)[0]
    : closest(sameExpiry.filter(({ contract }) => contract.strike > put.contract.strike), spot * (1 + COLLAR_DEFAULT_DISTANCE))[0];
  if (!call) throw strikes.call != null ? missing(sameExpiry, strikes.call, "call to sell") : new Error("The selected chain has no complete quoted call to sell above the put with usable IV");
  if (call.contract.strike <= put.contract.strike) throw new Error("A collar's put strike must be below its call strike");
  if (put.contract.currency !== call.contract.currency) throw new Error("Strategy quote currencies differ");
  const legs = [[put, "put", 1], [call, "call", -1]] as const;
  return {
    legs: legs.map(([{ contract, mid, volatility, solved }, side, quantity]): ScenarioLeg => ({
      id: contract.contractSymbol, side, quantity, strike: contract.strike, expiration: contract.expiration, price: mid,
      priceSource: "mid", volatility, multiplier: 100, ...(solved ? { volatilitySource: "mid" as const } : {}),
    })),
    parity: put.solved || call.solved ? parityFor(put.contract.expiration) : null,
  };
}

export function scenarioControlsFromSettings(settings: Record<string, unknown>, position: ScenarioPosition): ScenarioControls {
  const volShift = (numericSetting(settings, "volShift") ?? 0) / 100;
  const spotRange = (numericSetting(settings, "spotRange") ?? 30) / 100;
  if (volShift < -5 || volShift > 5) throw new Error("volShift must be between -500 and 500 percentage points");
  if (spotRange <= 0 || spotRange > 3) throw new Error("spotRange must be greater than 0 and at most 300 percent");
  return { date: dateSetting(settings, "date") ?? position.asOf, volShift, spotRange };
}
