import type { AppConfig } from "./config";
import type { DataProvider } from "./data-provider";

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

interface HeadlessPaneResultBase {
  errors?: string[];
  metadata?: Record<string, unknown>;
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
  argument: HeadlessPaneArgumentDef;
  options: HeadlessPaneOptionDef[];
  columns?: HeadlessPaneColumn[];
  describe?: string | ((args: HeadlessPaneLoadArgs) => string);
  load(
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): HeadlessPaneResultByShape[Shape] | Promise<HeadlessPaneResultByShape[Shape]>;
}

export type HeadlessPaneResult = HeadlessPaneResultByShape[HeadlessPaneShape];
