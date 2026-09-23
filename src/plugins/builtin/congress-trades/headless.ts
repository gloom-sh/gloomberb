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
  formatCongressReturn,
  formatLag,
  formatShortDate,
  sortedMembers,
  sortedTrades,
  sortedTickers,
} from "./model";
import type { CloudCongressHouseParams } from "../../../api-client/paths";

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
  { key: "returnSinceTx", header: "Tx return", format: value => formatCongressReturn(typeof value === "number" ? value : null) },
  { key: "returnSinceFiling", header: "Filed return", format: value => formatCongressReturn(typeof value === "number" ? value : null) },
];

const MEMBER_COLUMNS: HeadlessPaneColumn[] = [
  { key: "memberName", header: "Member" },
  { key: "stateDistrict", header: "Dist" },
  { key: "party", header: "Party" },
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
  { key: "medianReturn", header: "Median return", format: value => formatCongressReturn(typeof value === "number" ? value : null) },
  { key: "pricedTradeCount", header: "Priced trades" },
  { key: "buyHitRate", header: "Buy hit", align: "right", format: value => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "--" },
  { key: "pricedBuyCount", header: "Priced buys" },
];

export interface CongressHeadlessDependencies {
  loadHouse(
    args: HeadlessPaneLoadArgs,
    ctx: HeadlessPaneContext,
  ): Promise<CloudCongressHousePayload>;
}

const defaultDependencies: CongressHeadlessDependencies = {
  loadHouse: (args, ctx) => loadCongressHouse({
    chamber: (args.options.chamber as CloudCongressHouseParams["chamber"]) ?? "all",
    year: Number(args.options.year),
    limit: CONGRESS_TRADE_LIMIT,
    filingLimit: CONGRESS_FILING_LIMIT,
    ticker: args.symbols[0],
    offset: Number(args.options.offset ?? 0),
    filingOffset: Number(args.options.filingOffset ?? 0),
    side: args.options.side === "all" ? undefined : args.options.side as CloudCongressHouseParams["side"],
    owner: args.options.owner === "all" ? undefined : args.options.owner as CloudCongressHouseParams["owner"],
    assetType: args.options.assetType === "all" ? undefined : args.options.assetType as CloudCongressHouseParams["assetType"],
    minAmount: Number(args.options.minAmount ?? 0),
  }, ctx.apiClient, ctx.signal),
};

export function createCongressHeadless(
  dependencies: CongressHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    argument: {
      kind: "ticker",
      optional: true,
      description: "Optional ticker to filter Congress PTR trades.",
    },
    options: [
      { key: "chamber", description: "House, Senate, or both merged by filing date.", type: "enum", defaultValue: "all", values: ["all", "house", "senate"].map((value) => ({ value })) },
      { key: "offset", description: "Trade offset within the filing window.", type: "integer", defaultValue: 0, minimum: 0 },
      { key: "filingOffset", description: "Offset into the year's filing index.", type: "integer", defaultValue: 0, minimum: 0 },
      {
        key: "tab",
        description: "Congress pane tab.",
        type: "enum",
        values: [{ value: "trades" }, { value: "members" }, { value: "tickers" }],
        defaultValue: "trades",
        pluginState: { pluginId: "gloomberb-cloud", key: "activeTab" },
      },
      {
        key: "year",
        description: "Disclosure year.",
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
      { key: "side", description: "Transaction side.", type: "enum", defaultValue: "all", values: ["all", "BUY", "SELL", "EXCHANGE", "OTHER"].map((value) => ({ value })) },
      { key: "owner", description: "Disclosed owner.", type: "enum", defaultValue: "all", values: ["all", "self", "spouse", "joint", "dependent", "other"].map((value) => ({ value })) },
      { key: "assetType", description: "Asset category.", type: "enum", defaultValue: "all", values: ["all", "stock", "option", "other"].map((value) => ({ value })) },
      { key: "minAmount", description: "Minimum disclosed lower dollar bound.", type: "integer", defaultValue: 0, minimum: 0 },
    ],
    describe: (args) => `Congress Trades | ${args.options.tab === "members" ? "Members" : args.options.tab === "tickers" ? "Tickers" : "Trades"}`,
    async load(args, ctx) {
      const payload = await dependencies.loadHouse(args, ctx);
      const limit = Number(args.options.limit);
      if (args.options.tab === "tickers") {
        return {
          columns: [
            { key: "ticker", header: "Ticker" }, { key: "buyCount", header: "Buys", align: "right" },
            { key: "sellCount", header: "Sells", align: "right" }, { key: "memberCount", header: "Members", align: "right" },
            { key: "estimatedLow", header: "Est Range", format: (_value, row) => formatAmountRange(row.estimatedLow as number | null, row.estimatedHigh as number | null) },
            { key: "lastFilingDate", header: "Last filed" },
          ],
          rows: sortedTickers(payload.tickers ?? [], { columnId: "buyCount", direction: "desc" }).slice(0, limit).map((row) => ({ ...row })),
          metadata: { asOf: payload.asOf, chamber: payload.chamber, source: payload.source, year: payload.year,
            aggregateScope: "filtered filing window", filingOffset: payload.filingOffset, filingsScanned: payload.filingsScanned,
            nextFilingOffset: payload.nextFilingOffset, hasMoreFilings: payload.hasMoreFilings,
            filingsPending: payload.filingsPending, filingsFailed: payload.filingsFailed,
            filingsPaper: payload.filingsPaper ?? 0, senateUnavailable: payload.senateUnavailable ?? false },
        };
      }
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
            nextOffset: payload.nextOffset,
            nextFilingOffset: payload.nextFilingOffset,
            hasMore: payload.hasMore,
            hasMoreFilings: payload.hasMoreFilings,
            filingsPending: payload.filingsPending,
            filingsFailed: payload.filingsFailed,
            filingsPaper: payload.filingsPaper ?? 0,
            senateUnavailable: payload.senateUnavailable ?? false,
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
          nextOffset: payload.nextOffset,
          nextFilingOffset: payload.nextFilingOffset,
          hasMore: payload.hasMore,
          hasMoreFilings: payload.hasMoreFilings,
          filingsPending: payload.filingsPending,
          filingsFailed: payload.filingsFailed,
          filingsPaper: payload.filingsPaper ?? 0,
          senateUnavailable: payload.senateUnavailable ?? false,
        },
      };
    },
  };
}

export const congressHeadless = createCongressHeadless();
