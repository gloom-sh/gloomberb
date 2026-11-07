import { apiClient } from "../../../api-client";
import type { BarsPerYearInstrument } from "../../../market-data/bars-per-year";
import { fxVolatilityPair, fxVolatilityProxyFund } from "../../../market-data/options-alternatives";
import type { PricePoint } from "../../../types/financials";
import { abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { loadIvHistory, type ImpliedVolatilityApi, type IvHistoryPayload, type IvMethod } from "../iv-history/client";
import { staleness } from "../iv-history/model";
import { realizedVolatilityResult } from "../shared/volatility";
import { createSurfaceDependencies, loadVolatilitySurface, type SurfaceLoaderDependencies } from "../vol-surface/client";
import type { SurfaceSnapshot } from "../vol-surface/model";

/**
 * An FX pair has no option chain here, and OTC FX volatility is not served:
 * the options of a currency fund that holds one side of it (USDJPY: FXY) are
 * the listed proxy. A thin one: the fund's chains often price an ATM level on
 * one or two expiries, and its IV reads above interbank FX volatility. So the
 * proxy is shown with its date, how many of the fund's expiries priced, and
 * how far its IV30 sits above the pair's own realized volatility.
 */
export interface FxVolProxy {
  /** The pair the symbol is (USDJPY for USDJPY=X or 6J=F). */
  pair: string;
  /** The fund whose options stand in (FXY). */
  fund: string;
  /** The fund's stored 30-day IV on its latest ranked close; null when there is none. */
  iv30: { value: number; date: string; method: IvMethod } | null;
  /** The fund's listed expiries that price an ATM IV now, of those read; null when its chains could not be read. */
  expiries: { usable: number; read: number } | null;
  /** What could not be read, said once: the proxy's history or its chains. */
  error: string | null;
}

export interface FxVolProxyDependencies {
  iv: ImpliedVolatilityApi;
  surface: SurfaceLoaderDependencies;
}

const CANCELLED = "FX volatility proxy load was cancelled";
const usableAtm = (value: number | null) => value != null && Number.isFinite(value) && value > 0;

/** The fund's 30-day IV on the close its rank is read on, else its newest reading with one. */
function proxyIv30(payload: IvHistoryPayload): FxVolProxy["iv30"] {
  const ranked = payload.stats?.iv30;
  if (ranked && Number.isFinite(ranked.value) && ranked.value > 0) return { value: ranked.value, date: ranked.date, method: ranked.method };
  const row = [...payload.series ?? []].reverse().find((point) => usableAtm(point.iv30));
  return row ? { value: row.iv30!, date: row.sessionDate, method: row.method } : null;
}

/** The fund's spot for its chains: the newest stored reading's. */
function proxySpot(payload: IvHistoryPayload): number | null {
  if (payload.latest?.spot && payload.latest.spot > 0) return payload.latest.spot;
  return [...payload.series ?? []].reverse().find((point) => point.spot != null && point.spot > 0)?.spot ?? null;
}

/** How many expiries read price an ATM IV that is not stale or failed. */
function usableExpiries(surface: SurfaceSnapshot): FxVolProxy["expiries"] {
  if (!surface.expiries.length) return null;
  return { usable: surface.expiries.filter((expiry) => usableAtm(expiry.atmIV) && !expiry.stale && !expiry.error).length,
    read: surface.expiries.length };
}

/** Null for a symbol that is no FX pair or currency future, or a pair no single fund stands in for. */
export async function loadFxVolProxy(
  request: { symbol: string; exchange?: string; signal?: AbortSignal },
  dependencies: FxVolProxyDependencies = { iv: apiClient, surface: createSurfaceDependencies() },
): Promise<FxVolProxy | null> {
  const pair = fxVolatilityPair(request.symbol, request.exchange);
  const fund = pair ? fxVolatilityProxyFund(pair) : null;
  if (!pair || !fund) return null;
  if (request.signal?.aborted) throw abortError(CANCELLED);
  let payload: IvHistoryPayload;
  try {
    payload = await loadIvHistory(fund, { signal: request.signal, days: 40 }, dependencies.iv);
  } catch (error) {
    if (request.signal?.aborted) throw abortError(CANCELLED);
    return { pair, fund, iv30: null, expiries: null, error: `${fund} IV history: ${errorMessage(error)}` };
  }
  const iv30 = proxyIv30(payload);
  const spot = proxySpot(payload);
  let expiries: FxVolProxy["expiries"] = null;
  let error: string | null = null;
  if (spot != null) {
    try {
      expiries = usableExpiries(await loadVolatilitySurface({ instrument: { symbol: fund }, spot, signal: request.signal }, dependencies.surface));
    } catch (failure) {
      if (request.signal?.aborted) throw abortError(CANCELLED);
      error = `${fund} options: ${errorMessage(failure)}`;
    }
  }
  return { pair, fund, iv30, expiries, error: error ?? (iv30 ? null : `${fund} has no IV30 yet`) };
}

/** The day of a bar, UTC. */
const barDay = (point: PricePoint) => new Date(point.date).toISOString().slice(0, 10);

export interface FxProxyReading {
  /** The pair's close-to-close HV20 on the proxy's IV30 close; null when the IV30 is stale or missing. */
  hv20: number | null;
  /** IV30 less that HV20; null as HV20 is. */
  spread: number | null;
  /**
   * The IV30 is over 5 of the fund's sessions behind the pair's last bar, as HIVG
   * counts a stale reading: FXB's IV30 of 18 May beside a November cone.
   */
  stale: boolean;
  /** What a stale IV30 says: "FXB has no IV30 since 2026-05-18". */
  note: string | null;
}

/**
 * The proxy's IV30 read against the pair: its age against the pair's last bar
 * (stale over 5 sessions, iv-history's `staleness`), and while it is current,
 * the pair's 20-bar realized volatility on the IV30's close and the IV30 less
 * it, HIVG's IV30 - HV20 with the fund's IV against the pair's own moves.
 * Close to close, whatever the pane's estimator, as HIVG reads it, and over
 * the pair's year (`instrument`: 260 bars for USDJPY=X, 252 for 6J=F). A stale
 * IV30 is no reading of the pair now: IV30 - HV20 is left out.
 */
export function fxProxyIvLessRv(proxy: FxVolProxy | null, history: readonly PricePoint[], instrument: BarsPerYearInstrument = {}): FxProxyReading {
  if (!proxy?.iv30) return { hv20: null, spread: null, stale: false, note: null };
  const through = proxy.iv30.date;
  const lastBar = history.length ? history.map(barDay).sort().at(-1)! : null;
  if (staleness(through, lastBar).stale) {
    return { hv20: null, spread: null, stale: true, note: `${proxy.fund} has no IV30 since ${through}` };
  }
  const upTo = history.filter((point) => barDay(point) <= through);
  const hv20 = upTo.length ? realizedVolatilityResult(upTo, 20, "close-to-close", instrument).value : null;
  return { hv20, spread: hv20 == null ? null : proxy.iv30.value - hv20, stale: false, note: null };
}

/** "FXY IV30", the label the proxy reads under in the pane, the chart legend and the report. */
export const fxProxyLabel = (proxy: Pick<FxVolProxy, "fund">) => `${proxy.fund} IV30`;
/** What the proxy is, said once: "FXY options, a thin ETF proxy". */
export const fxProxyNote = (proxy: Pick<FxVolProxy, "fund">) => `${proxy.fund} options, a thin ETF proxy`;
