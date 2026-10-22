import type { HistoryRetention } from "../sources/history-retention";
import type { PriceHistoryResult } from "../types/price-history";
import { LiveBarAccumulator } from "./live-bars";
import type { ChartResolutionSupport, ManualChartResolution } from "./resolution";
import type { DataProvider, MarketDataRequestContext } from "../types/data-provider";
import type { Quote, QuoteMetadata, TickerFinancials } from "../types/financials";
import type { FredSeriesLoadResult, FredSeriesRequest } from "../sources/gloomberb-cloud/fred-series";
import { chartQuoteOverrideKeyForSource } from "./live-quotes";
import { publicTickerKey } from "../utils/exchanges";
import type {
  ChartSeriesSpec,
  ChartSpec,
  ResolvedSeries,
} from "./types";

export interface ChartResolveSources {
  dataProvider: DataProvider | null;
  loadFredSeries: (request: FredSeriesRequest) => Promise<FredSeriesLoadResult>;
  now?: Date;
  /** Latest streamed quote per security identity, layered over snapshot data. */
  quoteOverrides?: ReadonlyMap<string, Quote>;
  /**
   * Start of the current uninterrupted quote observation. Bars formed from
   * quotes inside it are continuous with the loaded history.
   */
  liveSince?: number;
  /** Capture the resolved inputs, including the calculation buffer, for an export. */
  onSecurityData?: (series: ChartSeriesSpec, data: TickerFinancials, includesHistory: boolean) => void;
  /**
   * How often, in milliseconds, a plugin-owned series is loaded again while
   * it is charted; nothing for a series that keeps what it loaded.
   */
  capabilityRefreshMs?: (source: Extract<ChartSeriesSpec["source"], { kind: "capability" }>) => number | undefined;
  /**
   * What a futures price counts, from its contract terms ("USD / gallon"), so
   * the chart states it and a formula can tell gallons from barrels. Null where
   * the terms do not say. Without it a future's price is in its currency alone.
   */
  loadFuturesPriceUnit?: (symbol: string) => Promise<string | null>;
  /** Provider-neutral boundary for plugin-owned chart series. */
  resolveCapabilitySeries?: (
    source: Extract<ChartSeriesSpec["source"], { kind: "capability" }>,
    viewport: ChartSpec["viewport"],
    spec: ChartSeriesSpec,
  ) => Promise<ResolvedSeries>;
}

export interface ChartResolveOptions {
  /** Runtime zoom window used only to choose an adaptive Auto resolution. */
  autoViewport?: { start: Date; end: Date } | null;
  /** Runtime interaction window used to load history around the visible chart. */
  requestViewport?: { start: Date; end: Date } | null;
  /** Approximate number of horizontal observations the current surface can use. */
  targetPointCount?: number;
  /** Resolution currently on screen, kept through small Auto zooms. */
  currentResolution?: ManualChartResolution | null;
  /**
   * Price-only charts paint before slow broker support answers and stand in a
   * placeholder list meanwhile. One-shot loaders wait for the real list.
   */
  awaitResolutionSupport?: boolean;
  /** Fired once the real support list lands after a placeholder was used. */
  onResolutionSupportSettled?: () => void;
}

/** A current-window intraday history whose newest bars can be refreshed in place. */
export interface LiveTailRequest {
  source: Extract<ChartSeriesSpec["source"], { kind: "security" }>;
  resolution: ManualChartResolution;
  accumulationKey: string;
  historySession?: "extended";
}

/** Raw source data retained while live quotes recompute the chart tail. */
export class ChartResolveCache {
  readonly financialsByInstrument = new Map<string, Promise<TickerFinancials | null>>();
  readonly quoteMetadataByInstrument = new Map<string, Promise<QuoteMetadata | null>>();
  /** Each futures symbol's contract price unit, asked once per chart once known. */
  readonly futuresPriceUnits = new Map<string, Promise<string | null>>();
  readonly priceHistoryByRequest = new Map<string, Promise<LoadedPriceHistory>>();
  readonly priceHistoryExpiryByRequest = new Map<string, number>();
  readonly priceHistoryRefreshAfter = new Map<string, number>();
  readonly accumulatedPriceHistory = new Map<string, LoadedPriceHistory>();
  readonly resolutionSupportByInstrument = new Map<string, Promise<ChartResolutionSupport[]>>();
  readonly settledResolutionSupport = new Map<string, ChartResolutionSupport[]>();
  readonly rejectedResolutionSupport = new Set<string>();
  readonly fredSeriesByRequest = new Map<string, Promise<FredSeriesLoadResult>>();
  readonly capabilitySeriesByRequest = new Map<string, Promise<ResolvedSeries>>();
  /** Forming bars per accumulated history, kept across live re-resolves. */
  readonly liveBars = new Map<string, LiveBarAccumulator>();
  /** The loaded history each accumulated history last merged, so an unchanged load is not merged again. */
  readonly accumulatedFrom = new Map<string, LoadedPriceHistory>();
  /** Histories plotted by the latest resolve that follow the present. */
  liveTails: ReadonlyMap<string, LiveTailRequest> = new Map();
  tailReconcile: Promise<boolean> | null = null;
  /**
   * Bumped whenever source data enters the cache. A resolve that ran without a
   * bump changed at most what the quotes change: the newest points.
   */
  revision = 0;

  /** Broker history endpoints are paced per account, so their recent windows are requested less often. */
  get liveTailsUseBroker(): boolean {
    for (const tail of this.liveTails.values()) if (requestContext(tail.source).brokerId) return true;
    return false;
  }

  liveBarsFor(accumulationKey: string): LiveBarAccumulator {
    let bars = this.liveBars.get(accumulationKey);
    if (!bars) {
      bars = new LiveBarAccumulator();
      this.liveBars.set(accumulationKey, bars);
    }
    return bars;
  }

  /** True once after a streamed quote met a gap between the loaded history and now. */
  takeTailReconcileRequest(): boolean {
    let requested = false;
    for (const bars of this.liveBars.values()) requested = bars.takeReconcileRequest() || requested;
    return requested;
  }
}

export interface LoadedPriceHistory extends PriceHistoryResult {
  expiresAt?: number;
  requestKey?: string;
  accumulationKey?: string | null;
  /** The first bar the source has at this cadence, once it has said there is nothing older. */
  historyStart?: number;
  recovery?: {
    sourceKey: string;
    /** First bar requested from the retained window. */
    start: number;
    end: number;
    requiredWarmupPoints: number;
    usableWarmupPoints: number;
    /** The validated source evidence the recovery was requested with. */
    retention: HistoryRetention;
  };
}

export function requestContext(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): MarketDataRequestContext {
  return {
    brokerId: spec.instrument.instrument?.brokerId ?? spec.instrument.brokerId,
    brokerInstanceId: spec.instrument.instrument?.brokerInstanceId ?? spec.instrument.brokerInstanceId,
    instrument: spec.instrument.instrument ?? null,
  };
}

export function instrumentKey(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): string {
  return chartQuoteOverrideKeyForSource(spec);
}

export function instrumentLabel(spec: Extract<ChartSeriesSpec["source"], { kind: "security" }>): string {
  return publicTickerKey(spec.instrument.symbol, spec.instrument.exchange);
}
