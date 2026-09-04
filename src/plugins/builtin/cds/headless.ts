import type {
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
  HeadlessRowsResult,
} from "../../../types/plugin";
import {
  loadCdsActivity,
  type CdsActivity,
  type CdsFetch,
  type InstrumentSearch,
} from "./client";
import {
  DEFAULT_ISSUER_SORT,
  DEFAULT_TRADE_SORT,
  formatBp,
  formatEventTime,
  formatNotional,
  formatUpfront,
  sortIssuers,
  sortTrades,
  summarizeIssuers,
  type CdsTrade,
} from "./model";

const ISSUER_COLUMNS = [
  { key: "issuer", header: "Issuer" },
  { key: "trades", header: "Trades", align: "right" as const },
  { key: "lastTradeAt", header: "Last UTC", format: (value: unknown) => formatEventTime(Number(value)) },
  { key: "latestSpreadBp", header: "Spread", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
];

function tradeForFormatting(row: Record<string, unknown>): CdsTrade {
  return row as unknown as CdsTrade;
}

const TRADE_COLUMNS = [
  { key: "eventAt", header: "Time UTC", format: (value: unknown) => formatEventTime(Number(value)) },
  { key: "issuer", header: "Issuer" },
  { key: "maturity", header: "Maturity" },
  {
    key: "notional",
    header: "Notional",
    align: "right" as const,
    format: (_value: unknown, row: Record<string, unknown>) => formatNotional(tradeForFormatting(row)),
  },
  { key: "currency", header: "CCY" },
  { key: "couponBp", header: "Coupon", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
  { key: "spreadBp", header: "Spread", align: "right" as const, format: (value: unknown) => formatBp(value as number | null) },
  {
    key: "upfront",
    header: "Upfront",
    align: "right" as const,
    format: (_value: unknown, row: Record<string, unknown>) => formatUpfront(tradeForFormatting(row)),
  },
];

export function projectCdsHeadless(activity: CdsActivity, issuer: string | null): HeadlessRowsResult {
  if (issuer) {
    return {
      columns: TRADE_COLUMNS,
      rows: sortTrades(activity.trades, DEFAULT_TRADE_SORT).map((trade) => ({ ...trade })),
      metadata: { source: activity.source, asOf: activity.asOf, issuer: activity.issuer },
    };
  }
  return {
    columns: ISSUER_COLUMNS,
    rows: sortIssuers(summarizeIssuers(activity.trades), DEFAULT_ISSUER_SORT).map((issuerRow) => ({ ...issuerRow })),
    metadata: { source: activity.source, asOf: activity.asOf, issuer: null },
  };
}

export interface CdsHeadlessDependencies {
  load(
    args: HeadlessPaneLoadArgs,
    issuer: string | null,
    fetchCds: CdsFetch,
    searchInstruments: InstrumentSearch,
  ): Promise<CdsActivity>;
}

const defaultDependencies: CdsHeadlessDependencies = {
  load: (_args, issuer, fetchCds, searchInstruments) => (
    loadCdsActivity(issuer, fetchCds, searchInstruments)
  ),
};

export function createCdsHeadless(
  dependencies: CdsHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "free-text",
      placeholder: "ticker or issuer",
      description: "Optional ticker or issuer. Omit for the most-active issuer view.",
      optional: true,
    },
    options: [],
    describe: (args) => typeof args.argument === "string" ? `CDS | ${args.argument}` : "Single-Name CDS",
    async load(args, ctx) {
      const issuer = typeof args.argument === "string" ? args.argument : null;
      const activity = await dependencies.load(
        args,
        issuer,
        (params) => ctx.apiClient.getCloudCds(params),
        (query, limit) => ctx.apiClient.searchInstruments(query, limit),
      );
      return projectCdsHeadless(activity, issuer);
    },
  };
}

export const cdsHeadless = createCdsHeadless();
