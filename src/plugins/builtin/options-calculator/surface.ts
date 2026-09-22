import { apiClient } from "../../../api-client";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import type { InstrumentRef, OptionsRequest } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import type { OptionsChain, Quote } from "../../../types/financials";
import type { DataProvider } from "../../../types/data-provider";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { loadVolatilitySurface, type SurfaceLoaderDependencies } from "../vol-surface/client";
import { evaluateSurfaceSmile, type SurfaceSnapshot } from "../vol-surface/model";
import { interpolateTotalVariance, logForwardMoneyness } from "../shared/volatility";
import { daysToExpiryFrom } from "./model";
import type { YieldPoint } from "../yield-curve/treasury-data";

export interface CalculatorSurfaceRequest {
  symbol: string;
  exchange?: string;
  /** Hypothetical calculator spot. Surface fitting always uses a separate observed market quote. */
  spot: number;
  strike: number;
  daysToExpiry: number;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

export interface CalculatorSurfaceVol {
  volatility: number | null;
  rate: number | null;
  dividendYield: number | null;
  asOf: string | null;
  sourceSpot: number | null;
  spotAsOf: number | null;
  rateAsOf: string[];
  source: string;
  warnings: string[];
  error: string | null;
}

export interface CalculatorSurfaceDependencies extends SurfaceLoaderDependencies {
  loadQuote(instrument: InstrumentRef, options?: { forceRefresh?: boolean }): Promise<QueryEntry<Quote>>;
}

export function createCalculatorSurfaceDependencies(
  marketData?: DataProvider,
  cloudApi: { getCloudYieldCurve(): Promise<YieldPoint[]> } = apiClient,
): CalculatorSurfaceDependencies {
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  const unavailable = () => Promise.reject(new Error("Market data coordinator unavailable"));
  return {
    loadOptions: (request, options) => coordinator?.loadOptions(request, options) ?? unavailable(),
    loadQuote: (instrument, options) => coordinator?.loadQuote(instrument, options) ?? unavailable(),
    loadYieldCurve: () => cloudApi.getCloudYieldCurve(),
  };
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const expiryLabel = (expiration: number): string => new Date(expiration * 1000).toISOString().slice(0, 10);
const empty = (error: string, warnings: string[] = []): CalculatorSurfaceVol => ({
  volatility: null, rate: null, dividendYield: null, asOf: null, sourceSpot: null, spotAsOf: null, rateAsOf: [],
  source: "OVDV midpoint", warnings, error,
});
const abortError = () => new DOMException("Surface volatility load was cancelled", "AbortError");

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function bracketingExpiries(catalogue: readonly number[], years: number, now: number): number[] {
  const sorted = [...new Set(catalogue)].filter((expiration) => positive(expiration) && daysToExpiryFrom(expiration, now) > 0)
    .sort((a, b) => a - b);
  const exact = sorted.find((expiration) => Math.abs(daysToExpiryFrom(expiration, now) / 365 - years) < 1e-12);
  if (exact != null) return [exact];
  const right = sorted.findIndex((expiration) => daysToExpiryFrom(expiration, now) / 365 > years);
  return right <= 0 ? [] : [sorted[right - 1]!, sorted[right]!];
}

/** Match OVDV fixed-tenor interpolation at one fixed forward log-moneyness. */
export function projectCalculatorSurfaceVol(
  snapshot: SurfaceSnapshot,
  request: Pick<CalculatorSurfaceRequest, "symbol" | "strike" | "daysToExpiry">,
): CalculatorSurfaceVol {
  const warnings = [...new Set([...snapshot.warnings, ...snapshot.failures.map((failure) =>
    `${failure.expiration == null ? "Surface" : expiryLabel(failure.expiration)}: ${failure.message}`)])];
  if (snapshot.symbol !== parsePublicTickerKey(request.symbol).symbol || !positive(snapshot.spot)) {
    return empty("Surface snapshot does not match the requested underlying mark", warnings);
  }
  const years = request.daysToExpiry / 365;
  const brackets = bracketingExpiries(snapshot.catalogue, years, snapshot.fetchedAt);
  if (!brackets.length) return empty("Requested tenor is outside the listed surface range; extrapolation is unavailable", warnings);
  const selected = brackets.map((expiration) => snapshot.expiries.find((expiry) => expiry.expiration === expiration));
  for (let index = 0; index < selected.length; index += 1) {
    const expiry = selected[index];
    if (!expiry || expiry.stale || expiry.error || expiry.state !== "ready" || !expiry.fit
      || !positive(expiry.forward) || !finite(expiry.rate) || !finite(expiry.dividendYield)) {
      return empty(`${expiryLabel(brackets[index]!)} surface is ${expiry?.stale ? "stale" : "unavailable"}; both tenor brackets are required`, warnings);
    }
  }
  const left = selected[0]!, right = selected.at(-1)!;
  const weight = left === right ? 0 : (years - left.years) / (right.years - left.years);
  const rate = left.rate! + weight * (right.rate! - left.rate!);
  const dividendYield = left.dividendYield! + weight * (right.dividendYield! - left.dividendYield!);
  const forward = snapshot.spot * Math.exp((rate - dividendYield) * years);
  const k = logForwardMoneyness(request.strike, forward);
  if (k == null) return empty("Requested strike or implied forward is invalid", warnings);
  const values = selected.map((expiry) => ({ years: expiry!.years,
    volatility: evaluateSurfaceSmile(expiry!, expiry!.forward! * Math.exp(k)) }));
  if (values.some((point) => !positive(point.volatility))) {
    return empty("Requested strike is outside cleaned smile support in a tenor bracket; extrapolation is unavailable", warnings);
  }
  const interpolated = interpolateTotalVariance(values.map((point) => ({ years: point.years, volatility: point.volatility! })),
    left === right ? left.years : years);
  if (!interpolated || interpolated.extrapolated) return empty("Surface variance interpolation is unavailable", warnings);
  const dates = [...new Set(selected.flatMap((expiry) => expiry?.asOf && Number.isFinite(Date.parse(expiry.asOf)) ? [expiry.asOf] : []))];
  const asOf = dates.length ? dates.toSorted((a, b) => Date.parse(a) - Date.parse(b))[0]! : null;
  if (selected.some((expiry) => !expiry?.asOf || !Number.isFinite(Date.parse(expiry.asOf)))) warnings.push("Surface quote observation date unavailable");
  if (dates.length > 1) warnings.push(`Surface quote dates differ: ${dates.join(", ")}`);
  const rateDates = [...new Set(selected.flatMap((expiry) => expiry!.rateAsOf))];
  if (!rateDates.length) warnings.push("Treasury observation date unavailable");
  const fits = selected.map((expiry) => `${expiryLabel(expiry!.expiration)} ${expiry!.fit!.method} (${expiry!.source ?? "source unavailable"})`);
  return { volatility: interpolated.volatility, rate, dividendYield, asOf, rateAsOf: rateDates,
    sourceSpot: snapshot.spot, spotAsOf: typeof snapshot.spotAsOf === "number" ? snapshot.spotAsOf : null,
    source: `OVDV midpoint: ${fits.join(" / ")}`, warnings: [...new Set(warnings)], error: null };
}

/**
 * Pin the actual adjacent listings before fitting. Loading one representative
 * expiry plus both pins bounds requests to three slices and keeps OMON's cache.
 */
export async function loadCalculatorSurfaceVol(
  request: CalculatorSurfaceRequest,
  dependencies: CalculatorSurfaceDependencies = createCalculatorSurfaceDependencies(),
): Promise<CalculatorSurfaceVol> {
  if (request.signal?.aborted) throw abortError();
  const target = parsePublicTickerKey(request.symbol);
  const exchange = target.exchange ?? request.exchange;
  if (!target.symbol || !positive(request.strike) || !positive(request.daysToExpiry)) {
    return empty("Surface volatility needs a ticker, positive strike and remaining tenor");
  }
  const now = dependencies.now?.() ?? Date.now();
  const instrument = { symbol: target.symbol, exchange };
  const validateChain = (entry: QueryEntry<OptionsChain>, query: OptionsRequest): QueryEntry<OptionsChain> => {
    const chain = resolveEntryValue(entry);
    if (!chain) return entry;
    const actual = parsePublicTickerKey(chain.underlyingSymbol);
    if (actual.symbol !== target.symbol || (actual.exchange && exchange
      && canonicalExchange(actual.exchange) !== canonicalExchange(exchange))) throw new Error("Options chain identity does not match the requested ticker");
    const contracts = [...chain.calls, ...chain.puts];
    if (new Set(contracts.map((contract) => contract.currency).filter(Boolean)).size > 1) throw new Error("Surface quotes contain different currencies");
    if (query.expirationDate != null && (!chain.expirationDates.includes(query.expirationDate)
      || contracts.some((contract) => contract.expiration !== query.expirationDate))) throw new Error("Options source returned a different expiration");
    return entry;
  };
  try {
    const initialRequest = { instrument };
    const [rawInitial, quoteEntry] = await abortable(Promise.all([
      dependencies.loadOptions(initialRequest, { forceRefresh: request.forceRefresh }),
      dependencies.loadQuote(instrument, { forceRefresh: request.forceRefresh }),
    ]), request.signal);
    const initial = validateChain(rawInitial, initialRequest);
    if (request.signal?.aborted) throw abortError();
    const quote = resolveEntryValue(quoteEntry);
    if (!quote || quote.stale || quoteEntry.error || (quoteEntry.staleAt != null && quoteEntry.staleAt <= now)
      || !positive(quote.price)) return empty(quoteEntry.error?.message ?? "A current underlying quote is required for the surface");
    const quoteTarget = parsePublicTickerKey(quote.symbol);
    if (quoteTarget.symbol !== target.symbol || (quoteTarget.exchange && exchange
      && canonicalExchange(quoteTarget.exchange) !== canonicalExchange(exchange))) return empty("Underlying quote identity does not match the requested ticker");
    const chain = resolveEntryValue(initial);
    if (!chain || initial.error || (initial.staleAt != null && initial.staleAt <= now)) {
      return empty(initial.error?.message ?? "Current option expiry catalogue unavailable");
    }
    const requiredExpiries = bracketingExpiries(chain.expirationDates, request.daysToExpiry / 365, now);
    if (!requiredExpiries.length) return empty("Requested tenor is outside the listed surface range; extrapolation is unavailable");
    const snapshot = await loadVolatilitySurface({ instrument, spot: quote.price, spotAsOf: quote.lastUpdated, requiredExpiries, limit: 1,
      forceRefresh: request.forceRefresh, signal: request.signal }, {
      ...dependencies, now: () => now,
      loadOptions: async (query, options) => {
        const entry = query.expirationDate == null ? initial : validateChain(await dependencies.loadOptions(query, options), query);
        const chain = resolveEntryValue(entry);
        if (quote.currency && chain && [...chain.calls, ...chain.puts].some((contract) => contract.currency && contract.currency !== quote.currency)) {
          throw new Error("Surface quote currency differs from the underlying quote");
        }
        return entry;
      },
    });
    return projectCalculatorSurfaceVol(snapshot, { ...request, symbol: target.symbol });
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError();
    return empty(message(error));
  }
}
