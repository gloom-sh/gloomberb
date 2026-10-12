/**
 * Series a plugin registers for the data catalog and the chart composer.
 *
 * One definition is one catalog entry: a named line with a unit and a
 * frequency that the composer can draw next to any other entry. A definition
 * either loads its own history (`load`) or points at something the composer
 * already draws (`expression`), such as a FRED series or a ticker field.
 */

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
  /** What a report of this series cites in place of Gloom Cloud. */
  attribution?: SeriesAttribution;
}

export type SeriesLoadOutput = readonly SeriesPoint[] | SeriesLoadResult;

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
  /** Ask for a ticker, an option or a crypto pair before charting. */
  input?: SeriesInput;
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
  input?: SeriesInput;
  /** The chart expression; `{ticker}` stands for the input. */
  expression: string;
  pluginId: string;
}
