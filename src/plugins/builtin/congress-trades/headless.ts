import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { CloudCongressHousePayload } from "../../../api-client";
import { loadCongressHouse } from "./client";
import {
  CONGRESS_FILING_LIMIT,
  CONGRESS_TRADE_LIMIT,
  formatAmountRange,
  formatLag,
  formatShortDate,
  sortedMembers,
  sortedTrades,
} from "./model";

const TRADE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "filingDate", header: "Filed", format: (value) => formatShortDate(typeof value === "string" ? value : null) },
  { key: "transactionDate", header: "Tx", format: (value) => formatShortDate(typeof value === "string" ? value : null) },
  { key: "lagDays", header: "Lag", align: "right", format: (value) => formatLag(typeof value === "number" ? value : null) },
  { key: "memberName", header: "Member" },
  { key: "side", header: "Side" },
  { key: "ticker", header: "Ticker" },
  {
    key: "amountLow",
    header: "Amount",
    align: "right",
    format: (value, row) => formatAmountRange(
      typeof value === "number" ? value : null,
      typeof row.amountHigh === "number" ? row.amountHigh : null,
      typeof row.amount === "string" ? row.amount : undefined,
    ),
  },
  { key: "owner", header: "Owner" },
];

const MEMBER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "memberName", header: "Member" },
  { key: "stateDistrict", header: "Dist" },
  { key: "tradeCount", header: "Trades", align: "right" },
  { key: "buyCount", header: "Buy", align: "right" },
  { key: "sellCount", header: "Sell", align: "right" },
  {
    key: "estimatedLow",
    header: "Est Range",
    align: "right",
    format: (value, row) => formatAmountRange(
      typeof value === "number" ? value : null,
      typeof row.estimatedHigh === "number" ? row.estimatedHigh : null,
    ),
  },
  { key: "lastFilingDate", header: "Last", format: (value) => formatShortDate(typeof value === "string" ? value : null) },
  { key: "avgLagDays", header: "Avg", align: "right", format: (value) => formatLag(typeof value === "number" ? value : null) },
];

export interface CongressHeadlessDependencies {
  loadHouse(
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<CloudCongressHousePayload>;
}

const defaultDependencies: CongressHeadlessDependencies = {
  loadHouse: (args, ctx) => loadCongressHouse({
    year: Number(args.options.year),
    limit: CONGRESS_TRADE_LIMIT,
    filingLimit: CONGRESS_FILING_LIMIT,
  }, ctx.apiClient),
};

export function createCongressHeadless(
  dependencies: CongressHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "none",
      description: "The House PTR feed does not require an argument.",
    },
    options: [
      {
        key: "tab",
        description: "Congress pane tab.",
        type: "enum",
        values: [{ value: "trades" }, { value: "members" }],
        defaultValue: "trades",
        pluginState: { pluginId: "gloomberb-cloud", key: "activeTab" },
      },
      {
        key: "year",
        description: "House disclosure year.",
        type: "integer",
        defaultValue: new Date().getUTCFullYear(),
        minimum: 2008,
        maximum: 2100,
      },
      {
        key: "limit",
        aliases: ["count", "rows"],
        description: "Maximum rows.",
        type: "integer",
        defaultValue: 50,
        minimum: 1,
        maximum: 200,
      },
    ],
    describe: (args) => `Congress Trades | ${args.options.tab === "members" ? "Members" : "Trades"}`,
    async load(args, ctx) {
      const payload = await dependencies.loadHouse(args, ctx);
      const limit = Number(args.options.limit);
      if (args.options.tab === "members") {
        const rows = sortedMembers(payload.members, { columnId: "trades", direction: "desc" })
          .slice(0, limit)
          .map((member) => ({ ...member }));
        return {
          columns: MEMBER_COLUMNS,
          rows,
          metadata: {
            asOf: payload.asOf,
            chamber: payload.chamber,
            source: payload.source,
            year: payload.year,
          },
        };
      }
      const rows = sortedTrades(payload.trades, { columnId: "filed", direction: "desc" })
        .slice(0, limit)
        .map((trade) => ({ ...trade }));
      return {
        columns: TRADE_COLUMNS,
        rows,
        metadata: {
          asOf: payload.asOf,
          chamber: payload.chamber,
          source: payload.source,
          year: payload.year,
        },
      };
    },
  };
}

export const congressHeadless = createCongressHeadless();
