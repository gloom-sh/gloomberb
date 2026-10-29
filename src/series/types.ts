/**
 * Series a plugin registers for the data catalog and the chart composer.
 *
 * One definition is one catalog entry: a named line with a unit and a
 * frequency that the composer can draw next to any other entry. A definition
 * either loads its own history (`load`) or points at something the composer
 * already draws (`expression`), such as a FRED series or a ticker field.
 */
import type { ChartBarSize, ManualChartResolution } from "../time-series/resolution";

/** How often a series gets a new observation. */
export type SeriesFrequency =
  | "intraday"
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "irregular";

/**
 * What a series asks for before it can be charted: a ticker (AAPL), an option
 * contract (AAPL 260618C00200000) or a crypto pair (BTC-USD). A series without
 * an input charts as it is.
 */
export type SeriesInput = "ticker" | "option" | "crypto";

/** How a loaded series is drawn when it is first added to a chart. */
export type SeriesDrawStyle = "line" | "area" | "step" | "columns" | "points";

/**
 * Where a chart puts a series when it is added: `price` over its ticker's
 * price, on the price's axis (a moving average, a band around the price);
 * `panel` in a panel of its own under the price (an oscillator, a z-score).
 */
export type SeriesPlacement = "price" | "panel";

/** One of the lines a series draws, such as a band's middle or an edge. */
export interface SeriesLine {
  /** Letters, digits, ".", "_" or "-", unique in the series. */
  id: string;
  /** What the legend calls the line, after the series name. */
  name: string;
  /** How the line is drawn; the series' own style when omitted. */
  style?: SeriesDrawStyle;
  /** The line's colour as `#rrggbb`; one of the chart's own when omitted. */
  color?: string;
  /**
   * Another line of the series, by id: the area between the two is shaded in
   * this line's colour, under the lines (a band's edges, a channel).
   */
  fill?: string;
}

export interface SeriesPoint {
  /** The observation date: a Date, an ISO date or date-time string, or epoch milliseconds. */
  date: Date | string | number;
  /** Null marks a missing observation, which the chart draws as a gap. */
  value: number | null;
}

export interface SeriesLoadRequest {
  /** The first date the chart shows. Absent when the chart asks for all history. */
  start?: Date;
  /** The last date the chart shows. Absent means up to now. */
  end?: Date;
  /** The symbol typed for a series with an `input`, upper case (AAPL, BTC-USD). */
  ticker?: string;
  /**
   * The bar size the chart draws prices in (`1d`, `1wk`, `5m`): the one it
   * was set to, or its range's default. A series computed from a ticker's
   * bars uses it to compute on the same bars.
   */
  resolution?: ManualChartResolution;
  /**
   * Set when the chart builds its bars from `resolution` bars rather than
   * drawing those (`4h` from `1h`, `2d` from `1d`): the bar size it draws. A
   * series computed from a ticker's bars builds them the same way with
   * `aggregatePriceBars`, so its points fall on the chart's bars.
   */
  barSize?: ChartBarSize;
  signal?: AbortSignal;
}

/** Who a chart of a series cites, when the loaded data names it: the dataset (`FRED series ECBDFR`) and who published it. */
export interface SeriesAttribution {
  source: string;
  publisher?: string;
}

export interface SeriesLoadResult {
  points: readonly SeriesPoint[];
  /** A note the chart shows above the plot, such as "cached data is stale". */
  warning?: string;
  /**
   * When the copy the points came from was saved (ms), when its refresh failed
   * and that copy answered: the chart's footer says "saved copy from …".
   */
  savedAt?: number;
  /** What a report of this series cites in place of Gloom Cloud. */
  attribution?: SeriesAttribution;
}

/** What a series with `lines` loads: each line's observations, by line id. */
export interface SeriesLinesLoadResult extends Omit<SeriesLoadResult, "points"> {
  lines: Readonly<Record<string, readonly SeriesPoint[]>>;
}

export type SeriesLoadOutput = readonly SeriesPoint[] | SeriesLoadResult | SeriesLinesLoadResult;

interface SeriesDefinitionBase {
  /**
   * `namespace:name`, unique across the app, e.g. `fear-greed:index`. The
   * namespace belongs to the plugin that registers its first series; a loaded
   * series charts as `CAP:<id>`. Letters, digits, `.`, `_` and `-`.
   */
  id: string;
  /** What the catalog and the chart legend call the series. */
  name: string;
  /**
   * The unit every value is in. Series in the same unit share a chart axis.
   * See `describeSeriesUnits()` for the accepted forms: `%`, `bp`, `index`,
   * `USD`, `billion USD`, `thousand barrels/day` and so on.
   */
  unit: string;
  frequency: SeriesFrequency;
  /** The catalog tab the series is listed under, such as "Credit" or "Sentiment". */
  group?: string;
  /** Extra words the catalog search matches, such as a ticker the series is often read against. */
  tags?: readonly string[];
  /** One sentence for the catalog search and for `gloomberb` automation. */
  description?: string;
  /**
   * The official body that publishes the data (a statistics agency, a central
   * bank, an exchange regulator), when the series is public data. Never the
   * service a plugin fetches it from.
   */
  publisher?: string;
  /** The publisher's page for the series. */
  url?: string;
  /**
   * A limit on the data the publisher sets, such as a cap on how far back its
   * history goes. One sentence: the catalog lists it beside the series.
   */
  limitation?: string;
  /** Ask for a ticker, an option or a crypto pair before charting. */
  input?: SeriesInput;
  /**
   * Where a chart draws the series when it is added. `price` needs a ticker
   * `input` and a value in the ticker's price (unit `currency`). Without it,
   * the series joins the main panel when it fits there.
   */
  placement?: SeriesPlacement;
}

/** A series that loads its own history. */
export interface LoadedSeriesDefinition extends SeriesDefinitionBase {
  /**
   * The observations from `request.start` to `request.end`, oldest or newest
   * first. Returning more history than asked for is fine; the chart clips it.
   */
  load(request: SeriesLoadRequest): SeriesLoadOutput | Promise<SeriesLoadOutput>;
  /**
   * For a series that changes during the day: how often, in milliseconds, a
   * chart showing it loads it again. At least one minute.
   */
  refreshMs?: number;
  /** How the series is drawn when first added; a line when omitted. */
  style?: SeriesDrawStyle;
  /** The series' colour as `#rrggbb`; one of the chart's own when omitted. A line's own `color` wins. */
  color?: string;
  /**
   * Several lines drawn together, such as a band's middle and its edges, all
   * added to a chart at once; `load` returns them as `lines`.
   */
  lines?: readonly SeriesLine[];
  expression?: never;
}

/**
 * A catalog entry for something the chart composer already draws:
 * `FRED:UNRATE`, `UST:10Y`, `FUT:ES`, `^VIX:close`. With an `input`, write
 * `{ticker}` where the symbol goes: `{ticker}:close`.
 */
export interface ExpressionSeriesDefinition extends SeriesDefinitionBase {
  expression: string;
  load?: never;
  refreshMs?: never;
  style?: never;
  lines?: never;
}

export type SeriesDefinition = LoadedSeriesDefinition | ExpressionSeriesDefinition;

/** A definition as the registry holds it, with the plugin that registered it. */
export interface RegisteredSeries {
  definition: SeriesDefinition;
  /** The plugin that registered the series. */
  pluginId: string;
}

/**
 * What the catalog lists for a series, without functions: the shape that
 * crosses from the desktop's Bun process to its view.
 */
export interface SeriesCatalogEntry {
  id: string;
  name: string;
  unit: string;
  frequency: SeriesFrequency;
  group?: string;
  tags?: readonly string[];
  description?: string;
  publisher?: string;
  url?: string;
  limitation?: string;
  input?: SeriesInput;
  placement?: SeriesPlacement;
  /** The lines of a series that draws several, each with the expression that charts it alone. */
  /** A line that shades the area to another line is drawn as a `band`. */
  lines?: Array<{ id: string; name: string; style?: SeriesDrawStyle | "band"; expression: string }>;
  /** The chart expression; `{ticker}` stands for the input. */
  expression: string;
  pluginId: string;
}
