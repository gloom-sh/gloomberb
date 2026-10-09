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
}

export type HeadlessPaneRow = Record<string, unknown>;

export interface HeadlessPaneColumn {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  width?: number;
  description?: string;
  format?: (value: unknown, row: HeadlessPaneRow) => string;
}

export interface HeadlessPaneEntry {
  key?: string;
  label: string;
  value: unknown;
  /** Human-readable form used by text output while JSON retains `value`. */
  formatted?: string;
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
  /** The newest observation is stale once it is older than this many minutes. */
  maxAgeMinutes?: number;
  /**
   * The rows' and metadata's own `stale` flags mean something other than "this
   * value is out of date" (a historical marker, a cache state), so the report
   * judges staleness from the schedule alone.
   */
  ignoreStaleFlags?: boolean;
  /**
   * `daily`: one observation per US trading day, stale once more than one
   * completed session has passed after the newest (a day's lag is allowed).
   */
  cadence?: "daily";
  /** The newest observation is stale once this time (the next scheduled release) has passed by a day. */
  nextExpectedAt?: string | number | Date | null;
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
  metadata?: Record<string, unknown>;
  /** What this load knows about its data's source and age; overrides the definition's `freshness`. */
  freshness?: HeadlessPaneFreshness;
}

export interface HeadlessRowsResult extends HeadlessPaneResultBase {
  columns?: HeadlessPaneColumn[];
  rows: HeadlessPaneRow[];
}

export type HeadlessBundleSection =
  | {
    title: string;
    columns?: HeadlessPaneColumn[];
    rows: HeadlessPaneRow[];
    entries?: never;
  }
  | {
    title: string;
    entries: HeadlessPaneEntry[];
    columns?: never;
    rows?: never;
  };

export interface HeadlessBundleResult extends HeadlessPaneResultBase {
  sections: HeadlessBundleSection[];
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
  /** Explicit unit of the point values; report formatting does not rescale them. */
  unit?: string;
  points: HeadlessSeriesPoint[];
}

export interface HeadlessSeriesResult extends HeadlessPaneResultBase {
  series: HeadlessSeries[];
  stats?: Record<string, unknown> | HeadlessPaneEntry[];
}

export interface HeadlessSnapshotResult extends HeadlessPaneResultBase {
  asOf: string | number | Date;
  items: HeadlessPaneRow[];
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
    intents?: string[];
    dataRequirements?: string[];
    limitations?: string[];
    screenshotReadiness?: "ready" | "partial" | "live-dom" | "unsupported";
  };
  /**
   * What a report returns, in a sentence, for readers that only ever see the
   * function as a data source, such as Ask Gloom. The template's description
   * says what opening the pane does and is used when this is absent.
   */
  description?: string;
  argument: HeadlessPaneArgumentDef;
  options: HeadlessPaneOptionDef[];
  /** What is true of every load: its source, and whether it is a feed. */
  freshness?: HeadlessPaneFreshness;
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
