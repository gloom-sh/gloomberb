// The plugin API (`gloomberb/types/plugin`). The declarations live in the plugin-*.ts files beside this
// one, grouped by domain; this file only re-exports them, so every import path keeps resolving.

export type {
  HeadlessArgumentExpansion,
  HeadlessBundleResult,
  HeadlessBundleSection,
  HeadlessFreshnessStatus,
  HeadlessPaneApiClient,
  HeadlessPaneArgumentDef,
  HeadlessPaneArgumentKind,
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneFreshness,
  HeadlessPaneLoadArgs,
  HeadlessPaneOptionDef,
  HeadlessPaneOptionType,
  HeadlessPaneOptionValue,
  HeadlessPaneOptionValues,
  HeadlessPaneReference,
  HeadlessPaneResult,
  HeadlessPaneResultByShape,
  HeadlessPaneRow,
  HeadlessPaneShape,
  HeadlessRowsResult,
  HeadlessSeries,
  HeadlessSeriesPoint,
  HeadlessSeriesResult,
  HeadlessShotState,
  HeadlessSnapshotResult,
} from "./headless";
export type { TickerInstrumentKind } from "./instrument";
export { ALL_PLUGIN_TARGETS } from "./plugin-definition";
export type * from "./plugin-commands";
export type * from "./plugin-context";
export type * from "./plugin-contributions";
export type * from "./plugin-definition";
export type * from "./plugin-notifications";
export type * from "./plugin-pane-settings";
export type * from "./plugin-pane-templates";
export type * from "./plugin-panes";
export type * from "./plugin-reports";
export type * from "./plugin-shared";
export type * from "./plugin-state";
