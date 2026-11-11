import type { ChartResolution, CustomChartResolution, TimeRange } from "./range";
import type { ChartResolutionSupport, ManualChartResolution } from "./resolution";
import type { InstrumentRef } from "../market-data/request-types";
import type { SeriesAttribution } from "../series/types";

export const CHART_SPEC_VERSION = 2 as const;

export type SeriesPeriod = "auto" | "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "ttm";
/**
 * "band" draws a line through each point's value inside a shaded range from
 * its `low` to its `high`: an average within its historical range.
 */
export type SeriesStyle = "line" | "area" | "step" | "columns" | "points" | "candles" | "hollow" | "heikin-ashi" | "ohlc" | "hlc" | "band";
export type SeriesTransform = "raw" | "percent" | "index100" | "yoy" | "qoq" | "log";
export type SeriesAxis = "auto" | "left" | "right";
export type SeriesInterpolation = "none" | "step-after";
export type SeriesTimestampMode = "available-at" | "period-end";
export type PanelScale = "linear" | "log";

export interface SecuritySeriesSource {
  kind: "security";
  instrument: InstrumentRef;
  fieldId: string;
  period?: SeriesPeriod;
  timestampMode?: SeriesTimestampMode;
}

export interface EconomicSeriesSource {
  kind: "economic";
  provider: "fred";
  seriesId: string;
}

/** Persisted provider-owned source. The opaque series ID includes provider lookup identity. */
export interface CapabilitySeriesSource {
  kind: "capability";
  capabilityId: string;
  seriesId: string;
}

export type ChartSeriesSource = SecuritySeriesSource | EconomicSeriesSource | CapabilitySeriesSource;

export interface ChartSeriesSpec {
  id: string;
  source: ChartSeriesSource;
  label?: string;
  style: SeriesStyle;
  transform: SeriesTransform;
  axis: SeriesAxis;
  panelId: string;
  interpolation: SeriesInterpolation;
  color?: string;
  visible?: boolean;
}

export type ChartStudyKind =
  | "volume"
  | "sma"
  | "ema"
  | "bollinger"
  | "rsi"
  | "macd"
  | "realized-vol"
  | "vwap"
  | "anchored-vwap"
  | "volume-profile"
  | "atr"
  | "ratio"
  | "spread"
  | "correlation"
  /** A weighted sum of any number of series over a divisor: `(2*42*RB=F + 42*HO=F - 3*CL=F)/3`. */
  | "formula"
  /**
   * A leveraged or inverse fund's objective drawn from its index fund: `factor`
   * times the index fund's return each session, compounded (3× daily QQQ beside
   * TQQQ). Inputs: the index fund.
   */
  | "leverage"
  /**
   * How far a leveraged fund falls short of its objective, in percentage
   * points: the fund against the `factor`× daily line, and that line against
   * `factor` times the index fund's return over the period. Inputs: the fund,
   * then the index fund.
   */
  | "leverage-decay";

export interface ChartStudySpec {
  id: string;
  kind: ChartStudyKind;
  inputSeriesIds: string[];
  parameters: Record<string, number | string>;
  panelId: string;
  axis: SeriesAxis;
  color?: string;
  visible?: boolean;
}

export interface ChartPanelSpec {
  id: string;
  label?: string;
  height?: number;
  scale?: PanelScale;
}

export interface ChartViewportSpec {
  range: TimeRange;
  resolution: ChartResolution;
  dateWindow?: { start: string; end: string };
  /** Optional latest-observation cap, useful for period-based financial views. */
  maxPoints?: number;
  /** Intraday market history includes pre-market and after-hours bars where the venue has them. */
  extendedHours?: boolean;
  /**
   * Security price series are drawn as total returns: each cash distribution
   * is reinvested at the close of its ex-date bar. Price returns otherwise.
   */
  totalReturn?: boolean;
  /**
   * Security price series are converted into this currency (ISO code) at each
   * day's FX close, so their returns carry their currency's move. Each in its
   * listing's currency otherwise.
   */
  currency?: string;
}

export interface ChartSpec {
  version: typeof CHART_SPEC_VERSION;
  viewport: ChartViewportSpec;
  panels: ChartPanelSpec[];
  series: ChartSeriesSpec[];
  studies: ChartStudySpec[];
}

export type SeriesDataShape = "scalar" | "ohlcv" | "event" | "band";

export interface TimeSeriesPoint {
  date: Date;
  observedAt: Date;
  availableAt?: Date;
  /**
   * The day the figure was released (`2026-10-20`), when its source says so for
   * this point alone: FRED's newest observation from Gloom Cloud. The report
   * line reads it; unlike `availableAt`, it never moves where the point is
   * drawn or aligned, so the newest figure stays at its period like the rest.
   */
  releasedOn?: string;
  value: number | null;
  /** Original primary scalar before any presentation transform, including missing values. */
  rawValue?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  /** The bar this figure traded in closed below its open: volume draws it in the falling colour. */
  fell?: boolean;
  periodLabel?: string;
  /**
   * A financial statement period as the FA columns name it: `FY2025`, `Q3 FY26`,
   * `TTM Q3 FY26`, or the period's end date off the issuer's fiscal calendar.
   * The legend prints it beside the value.
   */
  fiscalPeriod?: string;
  /** A continuous future's bar (CL=F): the contract it closes on (CLZ26), as its history names it. */
  contract?: string;
  /** The bar's period had not ended when it was served: its close is the latest price. */
  partial?: boolean;
  /**
   * A formula's legs on this date, in the order it sums them: the contract
   * each was priced in (null where its bars name none) and that price.
   */
  legs?: ReadonlyArray<{ contract: string | null; price: number }>;
  /** A continuous future's contract, or a formula's legs', differ from the date before's: a roll. */
  roll?: boolean;
  /**
   * A price converted into the chart's currency (`viewport.currency`): what
   * its own-currency prices were multiplied by, that day's FX close over any
   * sub-unit divisor. Studies that compound a listing's own returns divide it
   * back out.
   */
  conversionFactor?: number;
  provenance?: {
    priceHistoryIntegrity?: import("../utils/price-history-integrity").PriceHistoryIntegrity;
    valuationPriceIssues?: import("./valuation-price").ValuationPriceIssue[];
    secEpsBasis?: import("../utils/sec-eps-basis").SecEpsBasis;
    /** @deprecated No longer populated. */
    earningsResult?: import("../types/financials").EarningsResultProvenance;
    unavailableEarnings?: import("../types/financials").EarningsField[];
    /** @deprecated No longer populated. */
    operatingResult?: import("../types/financials").OperatingResult;
    /** @deprecated No longer populated. */
    operatingResultAggregation?: import("../types/financials").OperatingResultAggregation;
    providerId?: string;
    quality?: "reported" | "derived" | "estimated";
    /** Reporting currency of this monetary statement observation. */
    currency?: string;
  };
}

export interface ResolvedSeriesMarketTimeBasis {
  kind: "market";
  /** IANA timezone used to recognize one exchange-local trading day. */
  timeZone: string;
  /** Canonical listing exchange, which sets the regular session's hours. */
  exchange?: string;
  /** Requested bar cadence when known; otherwise the chart derives it. */
  cadenceMs?: number;
}

export interface ResolvedSeries {
  id: string;
  label: string;
  /**
   * What a legend short of room shows before it cuts any of the label: a
   * company's one series without its field ("8058 Mitsubishi" for
   * "8058:JPX Close · Mitsubishi"), so five names cut alike do not read
   * "8058 Close · M..." and "8031 Close · M...".
   */
  compactLabel?: string;
  color: string;
  unit: string;
  /** Unit of rawValue, retained when presentation transforms change unit. */
  rawUnit?: string;
  /**
   * What a price series' returns are, set when the chart asked for total
   * returns: `total` once its distributions are reinvested, `price` when the
   * source gave none to reinvest (`warning` says why).
   */
  returnBasis?: "total" | "price";
  /** The listing currency a price series was converted from into the chart's `viewport.currency`. */
  convertedFrom?: string;
  unitGroup: string;
  /**
   * The unit the legend states beside each value, read bare as FUT prints its
   * price beside its unit: what a futures price counts ("USD / gallon"), where
   * the currency alone does not say it, and what a formula of them counts.
   */
  statedUnit?: string;
  /** Source instrument category used only for monetary market-price precision. */
  priceAssetCategory?: string;
  /**
   * The decimals a value worked out from prices (a formula, a spread, a price
   * over an FX rate) prints at: the most its legs print, from two to four.
   */
  valueDecimals?: number;
  /**
   * The grid a price quoted in fractions of a point moves on (a Treasury
   * future's half or quarter 32nd): its axis ticks fall on multiples of it,
   * never on decimal steps that read 104-25.60. Unset for decimal prices.
   */
  tickGrid?: number;
  /** Volume basis established by the source instrument; omitted when unspecified. */
  volumeUnit?: "shares" | "contracts";
  /**
   * Set where the volume is the combined volume of an index's members. It has
   * no unit of its own to state and nothing unknown to warn about; the volume
   * reads as "Members' volume".
   */
  volumeBasis?: "index-members";
  nativeFrequency: SeriesPeriod;
  /**
   * Set on a series with nothing to draw because its company reports no
   * figures of the period asked for, while its annual ones exist.
   */
  unreportedPeriod?: "quarterly";
  /**
   * Set where the series' current value is not meaningful (N/M): EV/EBITDA
   * over EBITDA at or below zero, or a bank's or an insurer's, with why and
   * the period it would end on (`valuationNotMeaningful`).
   */
  notMeaningful?: { reason: string; asOf: string };
  /** Acquired market-history cadence; null is explicitly unknown, undefined is legacy or nonmarket. */
  historyResolution?: ManualChartResolution | null;
  /**
   * The bar size the points were built in from `historyResolution` bars
   * (`4h` from `1h`, `2d` from `1d`). Absent when the points are the source's own bars.
   */
  barSize?: CustomChartResolution;
  /**
   * When known, the first bar this listing has at `historyResolution`: the
   * source keeps nothing older, so the chart stops there instead of asking.
   */
  historyStart?: Date;
  /** Authored time basis retained for layout and cursor semantics. */
  timestampMode?: SeriesTimestampMode;
  dataShape: SeriesDataShape;
  style: SeriesStyle;
  transform: SeriesTransform;
  axis: Exclude<SeriesAxis, "auto">;
  panelId: string;
  interpolation: SeriesInterpolation;
  /** Present only for exchange-traded market observations. */
  timeBasis?: ResolvedSeriesMarketTimeBasis;
  /**
   * The listing a market field reads, whose trading sessions studies such as
   * VWAP follow. Set even where no exchange time zone is known (futures).
   */
  listing?: { symbol: string; exchange: string };
  /**
   * A dataset series as a formula writes it (`FRED:BAMLC0A0CM`,
   * `CAP:cdx:ig`): what a formula's label and its unit errors name it by,
   * so they read as written rather than as the source's long title.
   */
  expression?: string;
  /**
   * A formula of futures: the legs it sums as written (`RB=F`), in the order
   * each point's `legs` names their contracts and prices.
   */
  formulaLegs?: readonly string[];
  /** A futures formula priced in one delivery month: the leg (`CL=F`) whose month the others take, rolling with it. */
  formulaLeader?: string;
  /** Price/volume observations and their derived studies, including 24/7
   * markets. Independent of whether the chart compresses exchange sessions.
   * `dataset`: a capability's published observations (vessel transits),
   * whose values the legend dates because they arrive days late. */
  observationKind?: "market" | "dataset";
  /** Regular-session move supplied with the latest market quote. */
  latestChangePercent?: number;
  /** The previous session's close, set on a one-day chart's price series and drawn as its reference line. */
  priorClose?: number;
  points: TimeSeriesPoint[];
  /** Who a report of a loaded series cites, when its loader names the dataset and publisher. */
  attribution?: SeriesAttribution;
  /**
   * The ticker whose price the values are in, such as a moving average of it:
   * the chart draws the series on that price's axis when it shows the price.
   */
  priceOf?: string;
  /** Rejected valuation price inputs, retained independently of usable observations. */
  valuationPriceIssues?: import("./valuation-price").ValuationPriceIssue[];
  warning?: string;
  /** When the copy the points came from was saved (ms), when its refresh failed and that copy answered. */
  savedAt?: number;
  /** Listed in the legend so it can be restored, but not drawn. */
  hidden?: boolean;
  /**
   * A layer of a stacked area (`stackedSeries`): a band from the layers below
   * to its own top, each point's `value` the top and `rawValue` the layer's own
   * amount, which the legend shows.
   */
  stacked?: boolean;
  /** Columns below zero take this colour instead, so a change reads by its sign. */
  negativeColor?: string;
  /**
   * Drawn as the volume traded at each price over the bars in view, against
   * the right edge, instead of as a line through its points.
   */
  profile?: { rows: number };
}

export interface TimeSeriesFieldDefinition {
  id: string;
  label: string;
  shortLabel: string;
  /** What a charted series is called after its symbol when that says more than `shortLabel`: the basis of its figures. */
  seriesLabel?: string;
  sourceKind: ChartSeriesSource["kind"];
  dataShape: SeriesDataShape;
  unit: string;
  unitGroup: string;
  nativeFrequency: SeriesPeriod;
  styles: SeriesStyle[];
  defaultStyle: SeriesStyle;
  transforms: SeriesTransform[];
  defaultInterpolation: SeriesInterpolation;
}

export interface ChartSeriesPriceHistoryIntegrity {
  seriesId: string;
  label: string;
  /** A selected source row, or a visible calculation affected by an earlier row. */
  scope: "requested-observation" | "visible-calculation";
  integrity: import("../utils/price-history-integrity").PriceHistoryIntegrity;
}

export interface ChartResolutionResult {
  series: ResolvedSeries[];
  /** Survives comparison clipping; contains selected rows and affected visible calculations, not unrelated loaded history. */
  priceHistoryIntegrity?: ChartSeriesPriceHistoryIntegrity[];
  /** Method and exact shared source dates for normalized closing-price comparisons. */
  priceComparison?: import("./price-comparison").PriceComparison;
  /** Provider capabilities shared by every active market series. */
  resolutionSupport?: ChartResolutionSupport[];
  /** Series available to the legend, including hidden base series that can be restored. */
  legendSeries?: ResolvedSeries[];
  /** Loaded observations retained outside the visible window for interactive navigation. */
  bufferedSeries?: ResolvedSeries[];
  /** Hidden market data retained as a deterministic session-time anchor. */
  timelineSeries?: ResolvedSeries[];
  loading: boolean;
  errors: string[];
  warnings: string[];
  /**
   * The oldest saved copy a shown series answered from after its refresh
   * failed (ms), which the chart's footer dates: "saved copy from …".
   */
  savedAt?: number;
  /**
   * Where a series' source starts after the range asked for, and why (a
   * publisher's cap on history), as `warnings` also carries it, so a report
   * says it where it would otherwise print a range that quietly starts later.
   */
  coverageNotices?: string[];
  /** What the price levels of a total-return chart without a comparison are (`warnings` also carries it). */
  returnBasisNotice?: string;
  /** The splits a comparison's listings took inside its range, its returns being split-adjusted (`warnings` also carries it). */
  splitNotice?: string;
  /**
   * Each charted listing that no longer trades: its symbol and label
   * ("Delisted Oct 27, 2022"), which `warnings` carries as "TWTR: Delisted Oct 27, 2022".
   */
  delistings?: { symbol: string; label: string; notice: string }[];
  /** Effective inclusive bounds used to clip the resolved chart data. */
  viewport?: { start: Date; end: Date };
  /** Bar resolution the loaded market history was fetched at. */
  resolution?: ManualChartResolution;
  /** The bar size the market series were built in from `resolution` bars, when the source does not serve it. */
  barSize?: CustomChartResolution;
}
