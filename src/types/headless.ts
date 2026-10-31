import type { AppConfig } from "./config";
import type { DataProvider } from "./data-provider";
import type { CapabilityInvoker } from "../capabilities/types";

type GloomApiClientInstance = typeof import("../api-client").apiClient;

/** Public methods of the shared cloud client, expressed structurally for alternate executors. */
export type HeadlessPaneApiClient = Pick<GloomApiClientInstance, keyof GloomApiClientInstance>;

export type HeadlessPaneShape = "rows" | "bundle" | "series" | "snapshot";
export type HeadlessPaneArgumentKind =
  | "none"
  | "ticker"
  | "tickers"
  | "symbol-list"
  | "free-text";
export type HeadlessPaneOptionType = "enum" | "integer" | "string" | "boolean";
export type HeadlessPaneOptionValues = Record<string, string | number | boolean>;

export interface HeadlessPaneArgumentDef {
  kind: HeadlessPaneArgumentKind;
  placeholder?: string;
  description?: string;
  optional?: boolean;
  /** Minimum item count for ticker and symbol list arguments. */
  minimum?: number;
  /** Maximum item count for ticker and symbol list arguments. */
  maximum?: number;
  /**
   * Arguments as typed after the function (`GAS`, `EUA`), which the catalog
   * shows as examples: for an argument that takes forms its placeholder does
   * not name.
   */
  examples?: readonly string[];
}

/** A list the catalog prints under a function's options, such as the sector names a screen's criteria match. */
export interface HeadlessPaneReference {
  title: string;
  items: readonly string[];
}

export interface HeadlessPaneOptionValue {
  value: string;
  aliases?: string[];
}


/**
 * Declarative option schema shared by headless panes and the pane function CLI.
 * `settingKey` and `pluginState` keep existing screenshot state wiring compatible.
 */
export interface HeadlessPaneOptionDef {
  key: string;
  description: string;
  type: HeadlessPaneOptionType;
  aliases?: string[];
  values?: HeadlessPaneOptionValue[];
  defaultValue?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  settingKey?: string;
  pluginState?: {
    pluginId: string;
    key?: string;
  };
  /**
   * Set when the pane does not draw the option and only the report reads it
   * (`--limit`'s rows of text): `shot` refuses it rather than capture the
   * pane without it; `reportOnly` says what the report does with it, for
   * the refusal (`sets how many rows the report lists`). Left out, the pane
   * draws it, through `settingKey`, `pluginState`, a setting of the option's
   * own key, or `shotState`.
   */
  shot?: { reportOnly: string };
  /**
   * Options this one stands in for (`--from` for `--range`): typed together
   * they are refused, since only one is read. The other's default does not
   * count.
   */
  replaces?: readonly string[];
  /** The value's name in the catalog's flag, `--expiration <date|unix>`; the type when absent. */
  placeholder?: string;
  /**
   * How many words one value is, for a value typed as a pair on the command
   * line (`--fx-shift TRY -20`): `fn` and `shot` read the words after the flag
   * into it. A word that ends with a comma starts another value of the list
   * (`--fx-shift TRY -20, EUR 5`), and so does the flag typed again. One when
   * absent.
   */
  valueWords?: number;
  /** The value is a comma list (`--metric trailingPE,dividendYieldPercent`), and the flag typed again adds to it. */
  list?: boolean;
  /** The option in use as typed after the function, such as `--expiration 2028-01-21`; the catalog shows it as an example. */
  example?: string;
  /** The example runs without the function's optional argument, as an option that works only then does (`fn INS --side sell`). */
  exampleWithoutArgument?: boolean;
  /**
   * Checks a typed value and returns it as the pane reads it, in place of the
   * type's own check; throws an Error that names what is wrong.
   */
  normalize?(value: string): string | number | boolean;
  /**
   * A sentence for a value the option does not take but people reach for,
   * such as `1s` for an intraday interval; null for the rest. `argument` is
   * what the function was given (its ticker), to name it in a pointer.
   */
  invalidValueHint?(value: string, argument: string | null): string | null;
}

export interface HeadlessPaneLoadArgs {
  rawArgument: string;
  argument: string | string[] | null;
  symbols: string[];
  options: HeadlessPaneOptionValues;
}

export interface HeadlessPaneContext {
  marketData: DataProvider;
  apiClient: HeadlessPaneApiClient;
  config: AppConfig;
  signal: AbortSignal;
  /** The caller asked for fresh data (`--refresh`) instead of cached copies. */
  refresh?: boolean;
  /** Effective instance settings, after template creation and option normalization. */
  settings?: Record<string, unknown>;
  capabilities?: CapabilityInvoker;
  /** The catalog's name for the series charted as an expression (`FRED:DFII10`); undefined for one it does not list. */
  catalogSeriesName?: (expression: string) => string | undefined;
  /** The catalog series a bare word is an alias of (`hashrate` is CAP:bitcoin:hashrate); undefined for any other word. */
  catalogSeriesNamed?: (word: string) => { expression: string; name: string } | undefined;
  /** Locally registered broker adapters. Reports may read account data; they never submit orders. */
  resolveBroker?: (brokerType: string) => import("./broker").BrokerAdapter | null;
  /** Read one local portfolio without passing holdings through a remote endpoint. */
  resolvePortfolio?: (id: string) => Promise<{
    portfolio: import("./ticker").Portfolio;
    tickers: import("./ticker").TickerRecord[];
    /** The broker account the portfolio was last synced with, as saved on this device. */
    account?: import("./trading").BrokerAccount | null;
  } | null>;
  /** Read locally remembered watchlist membership. */
  resolveWatchlist?: (id: string) => Promise<import("./ticker").TickerRecord[] | null>;
  /** Resolve locally remembered exchange identities without coupling plugins to storage. */
  resolveInstrument?: (symbol: string) => Promise<{ symbol: string; exchange?: string }>;
  /**
   * Read a bare symbol as `quote` reads it: the listing its quote is for and
   * that listing's company, or null when nothing better than the symbol is
   * known. A code several companies list (BDI) throws asking which, with
   * `quote`'s message; `argumentWith(key)` is the function's argument naming
   * that listing instead (`BDI:TSX`), for the retry each listing offers.
   * `coinNote` is what `quote` says of a bare coin ticker read as a listing
   * that is not the coin (ETH, the Grayscale fund), for the report's warnings.
   */
  resolveListing?: (symbol: string, argumentWith: (key: string) => string) => Promise<{ symbol: string; exchange?: string; name?: string; coinNote?: string;
    /** What became of the company that had the symbol, as `quote` says it ("GOGL was Golden Ocean Group until 2025, now Cmb.Tech: CMBT"). */
    successorNote?: string } | null>;
  /**
   * What a plugin keeps on this device only (its `ctx.resume` state, never
   * synced), such as ALRT's log of the alerts the app fired; null when none.
   */
  readDeviceState?: <T = unknown>(pluginId: string, key: string) => T | null;
}

export type HeadlessPaneRow = Record<string, unknown>;

export interface HeadlessPaneColumn {
  key: string;
  header: string;
  /** Print `header` as written, a field name such as `source`, where reports would otherwise title-case it. */
  literalHeader?: boolean;
  /**
   * What the text report heads the column with when it can say more than an
   * export's header should (`Chg % UTC` over `Chg %`), printed as written;
   * CSV keeps `header`, so a column read by its name stays where it was.
   */
  textHeader?: string;
  align?: "left" | "right" | "center";
  width?: number;
  /**
   * A narrow text table never cuts a cell by default: text wraps in its cell
   * and columns move under their rows. False keeps the column on one line;
   * true lets the table cut it, for free text that names nothing (a
   * description), down to `minWidth`.
   */
  shrink?: boolean;
  /** The narrowest a text column wraps to, or a `shrink: true` column is cut to, in a narrow text table. */
  minWidth?: number;
  /**
   * When the text table does not fit a narrow width, columns move to lines
   * under their row, each value whole: a higher priority moves sooner, then
   * long text, then rightmost first. The first column stays.
   */
  stackPriority?: number;
  /** Once moved under the rows, only the first `stackRows` rows print the column; 0 leaves it out of a narrow table. */
  stackRows?: number;
  /** The text table leaves the column out when fitted to fewer terminal columns than this; exports and piped output keep it. */
  minTableWidth?: number;
  description?: string;
  format?: (value: unknown, row: HeadlessPaneRow) => string;
  /** What the text report prints when it can say more than an export should (a unit word beside a number); CSV and NDJSON keep `format`. */
  textFormat?: (value: unknown, row: HeadlessPaneRow) => string;
  /**
   * The row field naming the unit of this column's number, for a column whose
   * rows are quoted in different units (CDX spreads in `bp`, prices in
   * `price`). Exports write the bare number and that unit: in the header when
   * every row shares it, otherwise in a `<header> unit` column. A column whose
   * unit is the row's own (`rowUnitKey`) exports the bare number under its own
   * header, the row's `currency_or_unit` naming the unit.
   */
  unitKey?: string;
  /** With `unitKey`: always a `<header> unit` column, so the header is the same whichever rows loaded. */
  unitColumn?: boolean;
  /**
   * The text report prints the value on its own lines under the row instead
   * of in a column, for a footnote that belongs to that row; an empty value
   * prints nothing. Exports keep it as a column. `"line"`: one line cut to
   * the width, never wrapped (a story's summary under its headline).
   */
  underRow?: boolean | "line";
}

export interface HeadlessPaneEntry {
  key?: string;
  label: string;
  value: unknown;
  /** Human-readable form used by text output while JSON retains `value`. */
  formatted?: string;
  /**
   * The unit of a numeric `value` (`USD`, `USD per 1% move`). Exports then
   * write the value as it is, every digit, with the unit beside the label,
   * rather than read back the number `formatted` draws.
   */
  unit?: string;
  /**
   * In a report with `exportDated`, where this line is not of the section's own period and release (a previous
   * reading, a year ago): the period it covers, when it was released and what it is as of. A null `released`
   * or `asOf` leaves the cell blank rather than borrow the section's.
   */
  period?: string | null;
  released?: string | null;
  asOf?: string | null;
}

/**
 * How current a report's data is (docs/usage.md#how-current-a-report-is):
 * - `live`: a real-time feed, such as a streaming venue or a real-time quote.
 * - `delayed`: a feed held back on purpose, by `delayMinutes` when known.
 * - `stale`: a feed or scheduled release whose newest observation is older
 *   than that kind of data allows.
 * - `not-a-feed`: data that is not a feed at all (filings, fundamentals,
 *   calendars, statistics releases, calculators, local portfolio data). It
 *   never reads stale just because it is old.
 */
export type HeadlessFreshnessStatus = "live" | "delayed" | "stale" | "not-a-feed";

/**
 * What a report can cite about its data. Every field is optional: the report
 * fills what is missing from the result itself (quote `dataSource`,
 * `delayMinutes`, `stale`, `asOf`/`observedAt`/`lastUpdated` fields, the last
 * point of each series), so a pane declares only what that would get wrong.
 */
export interface HeadlessPaneFreshness {
  /**
   * Who a reader would cite: the venue, exchange or agency for primary data
   * ("SEC EDGAR", "Hyperliquid"), "Gloom Cloud" for aggregated market data,
   * "Local data" or "Your inputs". Never a data vendor or an internal provider id.
   */
  source?: string;
  /**
   * Who published the figures, as the data itself names them (FRED's series
   * source, `DTCC Public Price Dissemination`). Exports cite it; left out,
   * they say it was not published rather than guess.
   */
  publisher?: string;
  /** When the publisher released the data, as the data states it. Exports cite it; left out, they say it was not published. */
  publishedAt?: string | number | Date | null;
  /** Newest observation in the data. A `YYYY-MM-DD` string reads as a date without a time. */
  asOf?: string | number | Date | null;
  /** Oldest observation, mentioned when it is far older than `asOf`; `null` when the rows are a history. */
  oldest?: string | number | Date | null;
  /**
   * The row field that says when each row was observed, when it is not one of
   * the standard names (`asOf`, `observedAt`, `lastUpdated`...). The report is
   * then dated by that field alone, not by metadata stamps.
   */
  observedKey?: string;
  status?: HeadlessFreshnessStatus;
  /** How far a delayed feed is held back, in minutes. */
  delayMinutes?: number;
  /** What not-a-feed data is, in a few words: "filed data", "monthly release", "your inputs". */
  basis?: string;
  /**
   * The pane shows nothing from a market or a feed: the user's own notes and
   * rules, the app's connections, documentation, an account. A screenshot's
   * footer then carries no status line, which would date nothing or call the
   * app's own state "not a live feed". `fn` still cites `source` and `basis`.
   */
  local?: boolean;
  /**
   * How often the data is published, when its dates mark the start of a period
   * (a monthly statistic is dated the 1st). The report then names the month,
   * quarter or year, not a day it was never observed on. A semiannual estimate
   * is dated by the month it was made in (USDA's coffee and sugar balances),
   * so it names that month.
   */
  periodicity?: "monthly" | "quarterly" | "semiannual" | "annual";
  /**
   * How often the oldest observation publishes, when it is dated by its period
   * and the newest is not (a monthly statistic charted beside daily closes):
   * the report names its period, `Fri 23 Oct 2026 (oldest Sep 2026)`.
   */
  oldestPeriodicity?: "monthly" | "quarterly" | "semiannual" | "annual" | null;
  /**
   * When the newest observation was released, for figures dated by the period
   * they cover (a monthly statistic's 1 Sep): a date, or the time when the
   * publisher states it. The report is then as of that release and names both,
   * `Sep 2026, released Tue 20 Oct`; its age and staleness stay the period's.
   */
  releasedOn?: string | number | Date | null;
  /**
   * The newest row is a weekly or monthly bar whose period had not ended when
   * it was served (October's bar on 16 Oct), and the last day it covers so
   * far. The report is then dated by that day, `month to date, through Thu 15
   * Oct 2026`, not by the start of the period the bar is dated by.
   */
  periodToDate?: { period: "week" | "month"; through?: string | null };
  /** The newest observation is stale once it is older than this many minutes. */
  maxAgeMinutes?: number;
  /**
   * The rows' and metadata's own `stale` flags mean something other than "this
   * value is out of date" (a historical marker, a cache state), so the report
   * judges staleness from the schedule alone.
   */
  ignoreStaleFlags?: boolean;
  /**
   * The observations the rows are computed from, when that is not the rows
   * themselves: FXC's crosses come from its USD legs. The report reads these in
   * place of the rows for times, feed, delay, stale flags and venue sessions,
   * as a rendered pane's published observations are read, so the report and
   * the pane date the same data alike.
   */
  observations?: readonly HeadlessPaneRow[];
  /**
   * `daily`: one observation per US trading day, stale once more than one
   * completed session has passed after the newest (a day's lag is allowed).
   */
  cadence?: "daily";
  /** The venue whose trading days a `daily` cadence counts instead, when the app knows its sessions. */
  cadenceExchange?: string;
  /**
   * Whose trading day a dated (`YYYY-MM-DD`) as-of is, as a reader names the
   * market: `US` for a US trading or business day. The report then reads
   * `US trading day Fri 9 Oct 2026`, so a reader whose day is already Saturday
   * does not take the US Friday for theirs. Leave it out when the dates are not
   * one market's.
   */
  tradingDayMarket?: string;
  /** The newest observation is stale once this time (the next scheduled release) has passed by a day. */
  nextExpectedAt?: string | number | Date | null;
  /**
   * Observations of the world collected and published some days after they
   * happen (vessel transits, job postings, rental prices, grid queues), not
   * quotes. A screenshot then cites the source, the newest observation's date
   * and its lag in days (`Source: Gloom Cloud · observed Sun 4 Oct · lag 6d`),
   * never a market's session. Rows that are quotes keep the market line.
   */
  dataset?: boolean;
  /**
   * The rows are a listing's price bars, which its quote carries on (`G AAPL`,
   * `HP`). A screenshot dates them as it dates a quote board, by the quotes it
   * shows with their delay and market. Any other report that declares a
   * `status` ends its screenshot as it ends `fn`, whatever quotes the page loaded.
   */
  prices?: boolean;
  /**
   * What a dataset's newest observation is, when its every line names it:
   * `last trade` makes the `fn` footer, the pane footer and a screenshot read
   * the same, `Source: DTCC · last trade 2026-10-09 · lag 2 days`, dated as
   * the report's rows are, by ISO date.
   */
  observation?: string;
  /**
   * Each source's own newest observation, for data drawn from several venues
   * polled apart (a perpetuals board). The line then dates every source and
   * says how old the oldest of them is (`Binance 02:15 · Bybit 02:24 UTC ·
   * oldest 9 min`), or with `ageOnly` the oldest observation, and `asOf` is the
   * newest of them unless declared.
   */
  sources?: Array<{ source: string; asOf: string | number | Date }>;
  /** Say how old the oldest observation is (`oldest 4 min`): rows polled apart from one source. */
  oldestAge?: boolean;
  /**
   * Say how old the data is, the newest observation's time and `oldest 4 min`, and no more: no status word.
   * For rows priced apart from a snapshot refreshed on a schedule (CRYP's board), where `live` would call prices
   * that are minutes old real-time and `delayed` would call a snapshot renewed every few seconds held back. A row
   * that states its own feed (`dataSource`, `delayMinutes`) still says it, and so does a declared `status`.
   * Says how old the oldest observation is, as `oldestAge` does, even beside `sources`: a venue that streams some
   * rows and not others is as old as its oldest row, not its newest.
   */
  ageOnly?: boolean;
  /**
   * Rows quoted on several markets (a US line beside Xetra and Paris ones)
   * date each market's session in the status line, `US, XETRA and EPA Tue 13
   * Oct 2026 close`, instead of only the newest row's.
   */
  datesEachVenue?: boolean;
  /**
   * Exports also cite the oldest observation whenever the rows are dated
   * apart, not only when it is a day older: a portfolio valued at one
   * listing's Friday close and another's later print.
   */
  citeOldest?: boolean;
  /**
   * What the newest observation is, said before its time so the time is not read as when the report was read:
   * `newest story` dates a news list `newest story Tue 29 Sep 2026 20:17 UTC`.
   */
  asOfLabel?: string;
  /**
   * Say when the rows were retrieved too, after the newest one's date: a list
   * dated by its newest filing was not read then (`newest filing Tue 27 Oct
   * 2026 · retrieved Wed 28 Oct 2026 19:07 UTC`).
   */
  retrievedToo?: boolean;
  /** What the figures are, said after the status: `funding = current estimate, pays 08:00 UTC`. */
  note?: string;
  /**
   * Shorter forms of `note`, longest first, that a capture's status line too
   * narrow for the whole note says instead before it leaves the note out.
   */
  noteVariants?: string[];
  /**
   * When the figures reach readers and when the next ones are due, said right
   * after the as-of date: `published Fri 9 Oct, next settlement Thu 15 Oct,
   * published Mon 26 Oct` for a settlement a regulator publishes days later.
   */
  schedule?: string;
  /**
   * Shorter forms of `schedule`, longest first, that a status line too narrow
   * for the whole one says instead, with the not-a-feed basis left out first:
   * when the figures were published outlasts what kind of data they are.
   */
  scheduleVariants?: string[];
}

interface HeadlessPaneResultBase {
  /** False when usable output does not fully cover the requested inputs/depth. */
  complete?: boolean;
  /** Resolved inputs, including implicit peers or symbols parsed from an expression. */
  symbols?: string[];
  /** Missing inputs must remain visible even when other inputs returned rows. */
  unavailableSymbols?: string[];
  /** Failures: a source that did not answer, or a value that could not be computed. */
  errors?: string[];
  /**
   * Caveats about a report that did load: what it leaves out, what it assumes,
   * how a value was marked. One sentence each. They never make a report fail;
   * `complete: false` says when the report does not cover what was asked.
   */
  notes?: string[];
  /**
   * What the report could not do as it was asked and did instead, such as a
   * bar size the source does not serve for the range: `fn` prints each on
   * stderr and lists them under `warnings` in JSON. One sentence each.
   */
  warnings?: string[];
  metadata?: Record<string, unknown>;
  /** What this load knows about its data's source and age; overrides the definition's `freshness`. */
  freshness?: HeadlessPaneFreshness;
}

/** A table only `--csv` and `--ndjson` write, after the report's own rows. */
export interface HeadlessExportTable {
  title: string;
  columns: HeadlessPaneColumn[];
  rows: HeadlessPaneRow[];
  /** The unit every figure is in, which each exported row names in `currency_or_unit`. */
  unit?: string;
  /** The interval the rows are at (`1d`), which each exported row names in `interval`. */
  interval?: string;
}

export interface HeadlessRowsResult extends HeadlessPaneResultBase {
  columns?: HeadlessPaneColumn[];
  /**
   * The columns the text report prints in place of `columns`, when the
   * exports carry more than a terminal table should (each cell's source and
   * as-of beside it). CSV, NDJSON and JSON keep `columns`.
   */
  textColumns?: HeadlessPaneColumn[];
  rows: HeadlessPaneRow[];
  /** The rows `textColumns` read, when the text report adds lines that are no record (the position under its lots); `rows` when absent. CSV, NDJSON and JSON keep `rows`. */
  textRows?: HeadlessPaneRow[];
  /** What the report says when `rows` is empty, in place of "No data.": why there are none. */
  empty?: string;
  /**
   * The row fields naming each row's own unit, symbol and observation date
   * (an ISO date or instant), for rows of several series dated apart: each
   * exported row names them in `currency_or_unit`, `symbol_or_series` and
   * `as_of`, as a bundle section's `rowUnitKey`, `rowSymbolKey` and `rowAsOfKey` do.
   * A column whose `unitKey` is `rowUnitKey` exports its figures bare under its
   * own header, the row's unit named once in `currency_or_unit`.
   */
  rowUnitKey?: string;
  rowSymbolKey?: string;
  rowAsOfKey?: string;
  /** The interval every row is at (`daily`), which each exported row names in `interval`. */
  interval?: string;
  /**
   * Tables `--csv` and `--ndjson` write after the rows, each in its own
   * section, such as the dated history the rows sum up. The text report and
   * JSON leave them out.
   */
  exportTables?: HeadlessExportTable[];
}

export type HeadlessBundleSection =
  | {
    title: string;
    /**
     * The heading the text report prints in place of `title`, when it can say
     * more than an export's section name should (the scale its amounts are
     * printed in, "Total revenue, USD millions"). JSON, CSV and NDJSON keep
     * `title`, so a section read by its name stays where it was.
     */
    textTitle?: string;
    columns?: HeadlessPaneColumn[];
    rows: HeadlessPaneRow[];
    /** What the report says when `rows` is empty, in place of "No data.": why there are none, and what to run instead. */
    empty?: string;
    /**
     * The table the text report prints in place of `columns`, when the pane
     * shows other columns than the exported records carry: its cells formatted
     * and cut to fit a terminal, with ids and raw evidence left out. CSV,
     * NDJSON and JSON keep `columns` and `rows`.
     */
    textColumns?: HeadlessPaneColumn[];
    /** The rows `textColumns` read, when the pane's rows are not the records (one per holding and scenario shock); `rows` when absent. */
    textRows?: HeadlessPaneRow[];
    /**
     * The currency or unit the rows' figures are in (`USD per 1% move`),
     * which every exported row names in `currency_or_unit`.
     */
    unit?: string;
    /**
     * The row field naming each row's own unit, for a table of metrics whose
     * rows differ (`%`, a ratio, a count): each exported row names it in
     * `currency_or_unit` in place of `unit`, blank when the field is empty.
     */
    rowUnitKey?: string;
    /**
     * The row field naming the symbol each row is of, for a table of several
     * (a ranking): each exported row names it in `symbol_or_series`.
     */
    rowSymbolKey?: string;
    /**
     * The row field holding when each row's figures were observed (an ISO
     * date or instant), for rows dated apart: each exported row names it in
     * `as_of`, blank when the field is empty.
     */
    rowAsOfKey?: string;
    /** The bar interval the rows are of (`1d`), which every exported row names in `interval`. */
    interval?: string;
    /** The symbol every row is of, where the report's own is not (a section per name): each exported row names it in `symbol_or_series`. */
    symbol?: string;
    /** When every row was observed (an ISO date or instant), where it is not the report's newest: each exported row names it in `as_of`. */
    asOf?: string;
    /**
     * The free view holds this table back for Gloom Pro. Left empty, the text
     * report leaves it out and says once, on its Pro line, what Pro adds, in
     * place of a lock under each table; JSON keeps the section with `locked`.
     */
    locked?: boolean;
    entries?: never;
    textEntries?: never;
    period?: never;
    released?: never;
  }
  | {
    title: string;
    entries: HeadlessPaneEntry[];
    /**
     * The lines the text report prints in place of `entries`, when the pane
     * says in one line what the exported records keep apart (a range as
     * `low to high`, a level with its distance from spot). CSV, NDJSON and
     * JSON keep `entries`.
     */
    textEntries?: HeadlessPaneEntry[];
    /** The symbol the figures are of, where the report's own is not: each exported line names it in `symbol_or_series`. */
    symbol?: string;
    /**
     * When the figures were observed (an ISO date or instant), where it is not the report's newest: each exported line names it in `as_of`.
     * Null leaves `as_of` blank, for figures with no date of their own to state.
     */
    asOf?: string | null;
    /** In a report with `exportDated`: the period the figures cover, and when they were released (an ISO date or instant), which each exported line names in `period` and `released`. */
    period?: string;
    released?: string;
    textTitle?: never;
    columns?: never;
    rows?: never;
    textColumns?: never;
    textRows?: never;
    unit?: never;
    rowUnitKey?: never;
    interval?: never;
    locked?: never;
  };

export interface HeadlessBundleResult extends HeadlessPaneResultBase {
  sections: HeadlessBundleSection[];
  /**
   * What the report says once when no section has a row, in place of each
   * section's own `empty`: one reason covers them all (a ticker no source maps).
   */
  empty?: string;
}

export interface HeadlessSeriesPoint extends HeadlessPaneRow {
  date: string | number | Date;
  value?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
}

export interface HeadlessSeries {
  id: string;
  label: string;
  /** The company or security a security's series is of (Apple Inc.), from its quote. */
  name?: string;
  /** Explicit unit of the point values; report formatting does not rescale them. */
  unit?: string;
  /** The symbol or series ID the series was asked for as (`USDZAR=X`, `DEXSFUS`), which exports name each row by. */
  symbol?: string;
  /** The bar interval or observation frequency the points are at (`1d`, `1mo`, `daily`), as served, not as asked. */
  interval?: string;
  /** Decimal places the text report prints the latest value to (a correlation to 3); JSON and CSV keep every digit. */
  textDecimals?: number;
  /** The text report prints the latest value as the tables print an amount (63.33B), for a company's reported total; JSON and CSV keep every digit. */
  textCompact?: boolean;
  /** Each point's `value` is its bar's close: `--csv` and `--ndjson` write Close alone, JSON keeps both. */
  valueIsClose?: boolean;
  points: HeadlessSeriesPoint[];
}

export interface HeadlessSeriesResult extends HeadlessPaneResultBase {
  series: HeadlessSeries[];
  stats?: Record<string, unknown> | HeadlessPaneEntry[];
}

export interface HeadlessSnapshotResult extends HeadlessPaneResultBase {
  asOf: string | number | Date;
  items: HeadlessPaneRow[];
  /** What the report says when `items` is empty, in place of "No data.": why there are none. */
  empty?: string;
}

export interface HeadlessPaneResultByShape {
  rows: HeadlessRowsResult;
  bundle: HeadlessBundleResult;
  series: HeadlessSeriesResult;
  snapshot: HeadlessSnapshotResult;
}

export interface HeadlessPaneDefinition<Shape extends HeadlessPaneShape = HeadlessPaneShape> {
  shape: Shape;
  /** Optional discovery information; executors derive the rest from the definition. */
  discovery?: {
    id?: string;
    aliases?: string[];
    /**
     * Words that are no function's code but ask for this function's data
     * (IVOL, IV for implied volatility). They do not open it, since one word
     * can mean several functions: `fn IVOL` answers with the functions it
     * means and the commands that run them, and `catalog ivol` lists them first.
     */
    suggestFor?: string[];
    intents?: string[];
    dataRequirements?: string[];
    limitations?: string[];
    /** Names an option's values match, listed by the catalog under each title: EQS's sectors and industries. */
    reference?: HeadlessPaneReference[];
    screenshotReadiness?: "ready" | "partial" | "live-dom" | "unsupported";
  };
  /**
   * What a report returns, in a sentence, for readers that only ever see the
   * function as a data source, such as Ask Gloom. The template's description
   * says what opening the pane does and is used when this is absent.
   */
  description?: string;
  argument: HeadlessPaneArgumentDef;
  /**
   * The data covers US listings only, named as a sentence starts ("Time and
   * sales"). `fn` and `shot` answer a listing abroad with that and the
   * company's US listing instead of loading, so a symbol another company uses
   * in the US never shows that company's numbers.
   */
  usListingsOnly?: string;
  /**
   * A sentence that answer adds for a listing abroad, after its US listing:
   * where to read the nearest data the function has for it (time and sales
   * points at GIP's 1-minute bars). `key` is the listing as read, RMS:ASX.
   */
  usListingsOnlyHint?(key: string): string;
  /**
   * A typed symbol the function reads as another before it is resolved, with
   * the note that says so: OPX and OVDV read a bare BTC or ETH as the coin
   * (BTC-USD), whose options are the ones asked about, not the US fund that
   * trades as BTC. Null reads the symbol as typed.
   */
  symbolAlias?(typed: string): { symbol: string; note: string } | null;
  /**
   * A listing the function has no data for, answered before any request with
   * what exists instead: OPX and OVDV answer a coin nothing lists options on
   * (SOL-USD) with BTC and ETH options, and OVDV, VCA and HIVG an FX pair with
   * the currency funds' options. `key` is the listing as read; `details` is
   * the line after `message`, left out when the message says it all.
   */
  refuseSymbol?(key: string): { message: string; details?: string } | null;
  /**
   * `fn` exits 1 when the report has no name with data: no rows, or every row
   * is one of `unavailableSymbols`. A list that gives data for some names
   * exits 0 and names the others in its errors.
   */
  failsWithoutData?: boolean;
  options: HeadlessPaneOptionDef[];
  /**
   * Widens the argument before the function runs, so its report, its capture
   * and its pane all read the same symbols: RV's `--peers` adds a symbol's
   * competitors. Null runs the argument as typed.
   */
  expandArgument?(
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<HeadlessArgumentExpansion | null>;
  /**
   * How `shot` opens the pane on a request, past the settings its options
   * name: 13F opens the fund a name resolved to, on the tab its view names.
   * `load` is the report's own load, for state that depends on what it found.
   * `given` names the options typed, by key: `args` carries every option's
   * default too, which the pane may open on differently (M&A of one company
   * opens on every status, its report on pending), so state an option sets
   * is written only when it was asked for.
   * Throws when the pane cannot draw the request, which `shot` reports
   * instead of capturing another view.
   */
  shotState?(
    args: HeadlessPaneLoadArgs,
    load: () => Promise<HeadlessPaneResultByShape[Shape]>,
    given: ReadonlySet<string>,
  ): HeadlessShotState | Promise<HeadlessShotState>;
  /** What is true of every load: its source, and whether it is a feed. */
  freshness?: HeadlessPaneFreshness;
  /**
   * A `--csv` export also closes with the report's warnings, as notes, for a
   * report whose warnings say which rows it left out (a backtest's dropped
   * sessions), so a saved file keeps what stderr said.
   */
  exportWarnings?: boolean;
  /**
   * The rows are statistics dated by a period and a release, so `--csv` and
   * `--ndjson` end every table with `period`, `released` and `retrieved` after
   * the five fixed columns (a table's own columns of those names stand in for
   * them), and `as_of` is the release, from the section's `rowAsOfKey` or `asOf`.
   */
  exportDated?: boolean;
  columns?: HeadlessPaneColumn[];
  /**
   * The report title. A report passes the loaded result, so a title can name
   * what the load resolved (the view an `auto` query became, a fund's name).
   */
  describe?: string | ((args: HeadlessPaneLoadArgs, result?: HeadlessPaneResult) => string);
  load(
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): HeadlessPaneResultByShape[Shape] | Promise<HeadlessPaneResultByShape[Shape]>;
  /**
   * A smaller form of a loaded result for readers with a tight size budget,
   * such as Ask Gloom: only what `args` asked for, without full-precision
   * metadata. Reports, screenshots and panes always use the full result.
   */
  compact?(
    result: HeadlessPaneResultByShape[Shape],
    args: HeadlessPaneLoadArgs,
  ): HeadlessPaneResultByShape[Shape];
}

export type HeadlessPaneResult = HeadlessPaneResultByShape[HeadlessPaneShape];

/** What `shot` merges into the captured pane for a request (`shotState`). */
export interface HeadlessShotState {
  /** Merged into the pane's settings. */
  settings?: Record<string, unknown>;
  /** Merged into the pane's plugin state, by plugin id. */
  pluginState?: Record<string, Record<string, unknown>>;
}

/** What a function runs with once it has widened its argument (`expandArgument`). */
export interface HeadlessArgumentExpansion {
  /** The argument as it would be typed: `DUOL, COUR, CHGG`. */
  argument: string;
  /** Merged into the pane's settings, which the load reads as `ctx.settings` and the pane as its own. */
  settings?: Record<string, unknown>;
  /** The pane's title when the widened argument needs saying (`RV DUOL + auto peers by industry: Airlines`). */
  title?: string;
}
