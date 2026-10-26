import type {
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneLoadArgs,
} from "../../../types/plugin";
import type { CloudCongressHousePayload } from "../../../api-client";
import { formatShortDate } from "../../../utils/datetime-format";
import { loadCongressHouse } from "./client";
import {
  CONGRESS_FILING_LIMIT,
  CONGRESS_TRADE_LIMIT,
  formatAmountRange,
  formatCongressReturn,
  formatLag,
  FILING_DAY_FORMAT,
  sortedMembers,
  sortedTrades,
  sortedTickers,
  tradeAssetLabel,
} from "./model";
import type { CloudCongressHouseParams } from "../../../api-client/paths";
import { REPORT_PAGE, REPORT_ROWS } from "../shared/headless-options";

const TRADE_COLUMNS: HeadlessPaneColumn[] = [
  { key: "filingDate", header: "Filed", format: (value) => formatShortDate(typeof value === "string" ? value : null, FILING_DAY_FORMAT) },
  { key: "transactionDate", header: "Tx", format: (value) => formatShortDate(typeof value === "string" ? value : null, FILING_DAY_FORMAT) },
  { key: "lagDays", header: "Lag", align: "right", format: (value) => formatLag(typeof value === "number" ? value : null) },
  { key: "memberName", header: "Member" },
  { key: "side", header: "Side" },
  { key: "ticker", header: "Ticker" },
  {
    key: "assetName",
    header: "Asset",
    format: (value, row) => tradeAssetLabel({
      assetName: typeof value === "string" ? value : "",
      assetType: typeof row.assetType === "string" ? row.assetType : null,
      description: typeof row.description === "string" ? row.description : null,
    }),
  },
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
  { key: "lastFilingDate", header: "Last", format: (value) => formatShortDate(typeof value === "string" ? value : null, FILING_DAY_FORMAT) },
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

/** The filter bar's state for the filters asked for, as the pane stores it: "all" and a zero minimum are no filter. Null when none was. */
function shotFilters(options: HeadlessPaneLoadArgs["options"], given: ReadonlySet<string>): Record<string, string | number> | null {
  const keys = ["chamber", "side", "owner", "assetType", "minAmount"].filter((key) => given.has(key));
  if (!keys.length) return null;
  return Object.fromEntries(keys.flatMap((key) => {
    const value = options[key];
    return value === "all" || (key === "minAmount" && !Number(value)) ? [] : [[key, key === "minAmount" ? Number(value) : String(value)]];
  }));
}

export function createCongressHeadless(
  dependencies: CongressHeadlessDependencies = defaultDependencies,
): HeadlessPaneDefinition<"rows"> {
  return {
    shape: "rows",
    freshness: { source: "House and Senate disclosures", status: "not-a-feed", basis: "filed reports" },
    argument: {
      kind: "ticker",
      optional: true,
      description: "Optional ticker to filter Congress PTR trades.",
    },
    options: [
      { key: "chamber", description: "House, Senate, or both merged by filing date.", type: "enum", defaultValue: "all", values: ["all", "house", "senate"].map((value) => ({ value })) },
      { key: "offset", shot: REPORT_PAGE, description: "Trade offset within the filing window.", type: "integer", defaultValue: 0, minimum: 0 },
      { key: "filingOffset", shot: REPORT_PAGE, description: "Offset into the year's filing index.", type: "integer", defaultValue: 0, minimum: 0 },
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
        shot: { reportOnly: "reads one disclosure year, and the pane opens on the latest" },
        description: "Disclosure year.",
        type: "integer",
        defaultValue: new Date().getUTCFullYear(),
        minimum: 2008,
        maximum: 2100,
      },
      {
        key: "limit",
        shot: REPORT_ROWS,
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
    // A ticker's pane lists its trades only. The filters are the pane's filter bar, kept apart for a ticker's pane.
    shotState: (args, _load, given) => {
      if (args.symbols.length && args.options.tab !== "trades") {
        throw new Error(`The Congress pane for one ticker lists its trades only. Drop --tab ${args.options.tab} or ${args.symbols[0]} from shot, or run the report: gloom fn CG ${args.symbols[0]} --tab ${args.options.tab}`);
      }
      const filters = shotFilters(args.options, given);
      return filters ? { pluginState: { "gloomberb-cloud": { [`${args.symbols.length ? "congressTicker." : ""}filters`]: filters } } } : {};
    },
    async load(args, ctx) {
      const payload = await dependencies.loadHouse(args, ctx);
      const limit = Number(args.options.limit);
      const metadata = {
        asOf: payload.asOf,
        chamber: payload.chamber,
        source: payload.source,
        year: payload.year,
        nextFilingOffset: payload.nextFilingOffset,
        hasMoreFilings: payload.hasMoreFilings,
        filingsPending: payload.filingsPending,
        filingsFailed: payload.filingsFailed,
        filingsPaper: payload.filingsPaper ?? 0,
        senateUnavailable: payload.senateUnavailable ?? false,
      };
      if (args.options.tab === "tickers") {
        return {
          columns: [
            { key: "ticker", header: "Ticker" }, { key: "buyCount", header: "Buys", align: "right" },
            { key: "sellCount", header: "Sells", align: "right" }, { key: "memberCount", header: "Members", align: "right" },
            { key: "estimatedLow", header: "Est Range", format: (_value, row) => formatAmountRange(row.estimatedLow as number | null, row.estimatedHigh as number | null) },
            { key: "lastFilingDate", header: "Last filed" },
          ],
          rows: sortedTickers(payload.tickers ?? [], { columnId: "buyCount", direction: "desc" }).slice(0, limit).map((row) => ({ ...row })),
          // Tickers aggregate the filings scanned so far rather than paging rows.
          metadata: { ...metadata, aggregateScope: "filtered filing window", filingOffset: payload.filingOffset, filingsScanned: payload.filingsScanned },
        };
      }
      const pagedMetadata = { ...metadata, nextOffset: payload.nextOffset, hasMore: payload.hasMore };
      if (args.options.tab === "members") {
        const rows = sortedMembers(payload.members, { columnId: "trades", direction: "desc" })
          .slice(0, limit)
          .map((member) => ({ ...member }));
        return { columns: MEMBER_COLUMNS, rows, metadata: pagedMetadata };
      }
      const rows = sortedTrades(payload.trades, { columnId: "filed", direction: "desc" })
        .slice(0, limit)
        .map((trade) => ({ ...trade }));
      return { columns: TRADE_COLUMNS, rows, metadata: pagedMetadata };
    },
  };
}

export const congressHeadless = createCongressHeadless();
