import type { CryptoAssetKind, DefiTvlPayload, StablecoinSupplyPayload } from "../../../api-client/crypto-markets";
import type { HeadlessExportTable, HeadlessPaneColumn } from "../../../types/headless";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompact, formatCompactAmount } from "../../../utils/format";
import { errorMessage } from "../../../utils/errors";
import { fetchCryptoMarkets, fetchDefiTvl, fetchStablecoinSupply } from "./client";
import { buildDefiRows, defiHistoryRows, defiHistoryStart, defiSummaryLine, type DefiList, type DefiRow } from "./defi";
import {
  buildCryptoRows,
  CRYPTO_BOARD_FRESHNESS,
  CRYPTO_CHANGE_BASIS_LABEL,
  formatCryptoPercent,
  formatDayRangeTime,
  formatOffPeg,
  withCryptoSupply,
} from "./model";
import { stackedSupply, supplyByCode, supplyFailure, supplyHistoryRows, supplySummaryLine } from "./supply";

const NO_QUOTES = new Map();
const number = (value: unknown) => (typeof value === "number" ? value : null);
const percent = (value: unknown) => formatCryptoPercent(number(value));
const compact = (value: unknown) => (number(value) == null ? "—" : formatCompact(number(value)!, { fixedDecimals: true }));
const text = (key: string) => (_value: unknown, row: Record<string, unknown>) => String(row[key] ?? "—");
/** Exports keep the date; the text table reads `Sat 11:30`, the weekday enough inside 24 hours. */
const isoMinute = (value: unknown) => typeof value === "string" ? `${value.slice(0, 16).replace("T", " ")} UTC` : "";
const dayTime = (value: unknown) => formatDayRangeTime(typeof value === "string" ? Date.parse(value) : null);
const signedCompact = (value: unknown) => (number(value) == null ? "—" : formatCompactAmount(number(value)!, { signed: true }));
const share = (value: unknown) => (number(value) == null ? "—" : `${number(value)!.toFixed(2)}%`);

const COIN_COLUMNS: HeadlessPaneColumn[] = [
  { key: "rank", header: "#", align: "right" },
  { key: "code", header: "Coin" },
  { key: "name", header: "Name" },
  // Every coin is priced, traded and valued in US dollars: the text headers say so; an export keeps its headers.
  { key: "price", header: "Price", textHeader: "Price USD", align: "right", format: (_value, row) => String(row.priceText ?? "—") },
  // Since 00:00 UTC, the day `quote` gives a coin (CRYPTO_CHANGE_BASIS_LABEL): the text says so, as the pane's
  // CHG% UTC does, and an export keeps the header it has always had.
  { key: "changePercent", header: "Chg %", textHeader: "Chg % UTC", align: "right", format: percent },
  { key: "return7d", header: "7D %", align: "right", format: percent },
  { key: "return30d", header: "30D %", align: "right", format: percent },
  { key: "return1y", header: "1Y %", align: "right", format: percent },
  { key: "volume24h", header: "Vol 24h", textHeader: "Vol 24h USD", align: "right", format: compact },
  { key: "marketCap", header: "Market cap", textHeader: "Market cap USD", align: "right", format: compact },
];

/**
 * A stablecoin's peg, how far off it is and its 24-hour low and high with
 * their times follow its price. Fitted to a narrow terminal, the returns and
 * volume leave the table first.
 */
const STABLECOIN_COLUMNS: HeadlessPaneColumn[] = [
  ...COIN_COLUMNS.slice(0, 4),
  { key: "peg", header: "Peg", literalHeader: true, format: text("pegText") },
  { key: "offPegBp", header: "Off peg", literalHeader: true, align: "right", format: (value) => formatOffPeg(number(value)) },
  { key: "low24h", header: "24h low", literalHeader: true, align: "right", format: text("low24hText") },
  { key: "low24hAt", header: "Low UTC", literalHeader: true, shrink: false, format: isoMinute, textFormat: dayTime },
  { key: "high24h", header: "24h high", literalHeader: true, align: "right", format: text("high24hText") },
  { key: "high24hAt", header: "High UTC", literalHeader: true, shrink: false, format: isoMinute, textFormat: dayTime },
  ...COIN_COLUMNS.slice(4).map((column, index) => column.key === "marketCap"
    ? column
    : { ...column, stackPriority: 4 - index, stackRows: 0 }),
];

/**
 * With supply loaded, each coin's supply follows the market cap. In a narrow
 * terminal the supply's dollar changes and its share leave after the returns.
 */
const STABLECOIN_SUPPLY_COLUMNS: HeadlessPaneColumn[] = [
  ...STABLECOIN_COLUMNS,
  { key: "supply", header: "Supply", align: "right", format: compact },
  { key: "supply7dPercent", header: "Supply 7D %", align: "right", format: percent },
  { key: "supply7d", header: "Supply 7D", align: "right", format: signedCompact, stackPriority: 0.6, stackRows: 0 },
  { key: "supply30dPercent", header: "Supply 30D %", align: "right", format: percent },
  { key: "supply30d", header: "Supply 30D", align: "right", format: signedCompact, stackPriority: 0.8, stackRows: 0 },
  { key: "supplyShare", header: "Share", align: "right", format: share, stackPriority: 0.4, stackRows: 0 },
];

/** Daily supply in USD, oldest first: the total, the charted coins and the rest, for `--csv`. */
function supplyHistoryTable(payload: StablecoinSupplyPayload): HeadlessExportTable | null {
  const layers = stackedSupply(payload, "ALL")?.layers;
  const rows = supplyHistoryRows(payload);
  if (!layers || !rows.length) return null;
  return {
    title: "Stablecoin supply",
    unit: "USD",
    interval: "1d",
    columns: [
      { key: "date", header: "Date" },
      { key: "total", header: "Total", align: "right" },
      ...layers.map((layer) => ({ key: layer.id, header: layer.label, literalHeader: true, align: "right" as const })),
    ],
    rows,
  };
}

/** What the JSON report carries of the supply: the total line's figures and when they are from. */
function supplyMetadata(payload: StablecoinSupplyPayload) {
  return {
    status: payload.status,
    asOf: payload.asOf,
    fetchedAt: payload.fetchedAt,
    total: payload.total,
    charted: payload.history?.coins.map((coin) => coin.symbol) ?? [],
  };
}

const PROTOCOL_COLUMNS: HeadlessPaneColumn[] = [
  { key: "rank", header: "#", align: "right" },
  { key: "name", header: "Protocol" },
  { key: "category", header: "Category", stackPriority: 2, stackRows: 0 },
  { key: "tvl", header: "TVL", align: "right", format: compact },
  { key: "change1dPercent", header: "1D %", align: "right", format: percent, stackPriority: 3, stackRows: 0 },
  { key: "change7d", header: "7D", align: "right", format: signedCompact, stackPriority: 1, stackRows: 0 },
  { key: "change7dPercent", header: "7D %", align: "right", format: percent },
  { key: "change30d", header: "30D", align: "right", format: signedCompact, stackPriority: 0.5, stackRows: 0 },
  { key: "change30dPercent", header: "30D %", align: "right", format: percent },
  { key: "chains", header: "Chains", align: "right", stackPriority: 4, stackRows: 0 },
];

const CHAIN_COLUMNS: HeadlessPaneColumn[] = [
  { key: "rank", header: "#", align: "right" },
  { key: "name", header: "Chain" },
  { key: "token", header: "Token", stackPriority: 2, stackRows: 0 },
  { key: "tvl", header: "TVL", align: "right", format: compact },
  { key: "change7d", header: "7D", align: "right", format: signedCompact, stackPriority: 1, stackRows: 0 },
  { key: "change7dPercent", header: "7D %", align: "right", format: percent },
  { key: "change30d", header: "30D", align: "right", format: signedCompact, stackPriority: 0.5, stackRows: 0 },
  { key: "change30dPercent", header: "30D %", align: "right", format: percent },
  { key: "share", header: "Share", align: "right", format: share },
];

function defiRecord(row: DefiRow, list: DefiList) {
  return {
    rank: row.rank,
    name: row.name,
    ...(list === "chain" ? { token: row.detail } : { category: row.detail, chains: row.chains, change1dPercent: row.change1dPercent }),
    tvl: row.tvl,
    change7d: row.change7d,
    change7dPercent: row.change7dPercent,
    change30d: row.change30d,
    change30dPercent: row.change30dPercent,
    ...(list === "chain" ? { share: row.share } : {}),
  };
}

/** The other list and the total's daily history, for `--csv`: one file carries the whole tab. */
function defiExportTables(payload: DefiTvlPayload, list: DefiList): HeadlessExportTable[] {
  const other: DefiList = list === "chain" ? "protocol" : "chain";
  const otherRows = buildDefiRows(payload, other).map((row) => defiRecord(row, other));
  const history = defiHistoryRows(payload);
  return [
    ...(otherRows.length ? [{ title: other === "chain" ? "DeFi TVL by chain" : "DeFi TVL by protocol", unit: "USD", columns: other === "chain" ? CHAIN_COLUMNS : PROTOCOL_COLUMNS, rows: otherRows }] : []),
    ...(history.length ? [{
      title: "Total DeFi TVL",
      unit: "USD",
      interval: "1d",
      columns: [{ key: "date", header: "Date" }, { key: "tvl", header: "TVL", align: "right" as const }],
      rows: history,
    }] : []),
  ];
}

/**
 * `--list defi`: the largest protocols (or chains, `--by chain`) by TVL with
 * their 7D and 30D change, under the total's line. Dated by the total's day,
 * from a source that publishes it daily.
 */
async function loadDefi(list: DefiList, ctx: Parameters<HeadlessPaneDefinition<"rows">["load"]>[1]) {
  const payload = await fetchDefiTvl(ctx.apiClient);
  const rows = buildDefiRows(payload, list).map((row) => defiRecord(row, list));
  const summary = defiSummaryLine(payload);
  const exportTables = defiExportTables(payload, list);
  return {
    rows,
    columns: list === "chain" ? CHAIN_COLUMNS : PROTOCOL_COLUMNS,
    ...(exportTables.length ? { exportTables } : {}),
    errors: payload.warnings,
    ...(list === "protocol" && payload.protocolsAsOf ? { notes: [`Protocols as of ${isoMinute(payload.protocolsAsOf)}, the source's latest; their versions are counted together.`] } : {}),
    empty: list === "chain" ? "No chains returned." : "No protocols returned.",
    freshness: {
      source: "Gloom Cloud",
      publisher: payload.source.name,
      status: "not-a-feed" as const,
      basis: "daily TVL",
      asOf: payload.asOf,
      maxAgeMinutes: 36 * 60,
    },
    metadata: {
      list: "defi",
      by: list,
      status: payload.status,
      asOf: payload.asOf,
      fetchedAt: payload.fetchedAt,
      protocolsAsOf: payload.protocolsAsOf,
      source: payload.source,
      total: payload.total,
      historyStart: defiHistoryStart(payload),
      ...(summary ? { notices: [summary] } : {}),
    },
  };
}

export const cryptoBoardHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "none" },
  options: [{
    key: "list",
    description: "Coins, stablecoins, or DeFi TVL.",
    type: "enum",
    values: [
      { value: "coin", aliases: ["coins"] },
      { value: "stablecoin", aliases: ["stablecoins", "stable", "stables"] },
      { value: "defi", aliases: ["tvl"] },
    ],
    defaultValue: "coin",
    example: "--list stablecoin",
    pluginState: { pluginId: "market-overview", key: "activeTab" },
  }, {
    key: "by",
    // No default: the coin and stablecoin reports carry no `by`, and a missing one is by protocol.
    description: "DeFi TVL by protocol (the default) or by chain, with --list defi.",
    type: "enum",
    values: [
      { value: "protocol", aliases: ["protocols"] },
      { value: "chain", aliases: ["chains"] },
    ],
    example: "--list defi --by chain",
    pluginState: { pluginId: "market-overview", key: "defiList" },
  }],
  columns: COIN_COLUMNS,
  describe: (args) => `Crypto | ${args.options.list === "defi" ? `DeFi TVL by ${args.options.by === "chain" ? "chain" : "protocol"}` : args.options.list === "stablecoin" ? "Stablecoins" : "Coins"}`,
  discovery: {
    aliases: ["CRYP"],
    dataRequirements: ["Gloom Cloud crypto markets"],
  },
  // The board as the server read it, at most 15 seconds before; the pane streams, the report does not.
  // Each row keeps the time of its own last trade, so a coin that has not traded lately reads its age.
  freshness: CRYPTO_BOARD_FRESHNESS,
  async load(args, ctx) {
    if (args.options.list === "defi") return loadDefi(args.options.by === "chain" ? "chain" : "protocol", ctx);
    const kind = args.options.list === "stablecoin" ? "stablecoin" : "coin" satisfies CryptoAssetKind;
    // Supply is its own request: a failure there leaves the prices whole.
    const [data, supplyResult] = await Promise.all([
      fetchCryptoMarkets(ctx.apiClient),
      kind === "stablecoin"
        ? fetchStablecoinSupply(ctx.apiClient).then((payload) => ({ payload }), (error: unknown) => ({ error }))
        : null,
    ]);
    const supply = supplyResult && "payload" in supplyResult ? supplyResult.payload : null;
    const rows = withCryptoSupply(buildCryptoRows(data.assets, kind, NO_QUOTES), supplyByCode(supply)).map((row) => ({
      rank: row.rank,
      symbol: row.asset.symbol,
      code: row.code,
      name: row.name,
      price: row.price,
      priceText: row.priceText,
      changePercent: row.changePercent,
      return7d: row.return7d,
      return30d: row.return30d,
      return1y: row.return1y,
      volume24h: row.volume24h,
      marketCap: row.marketCap,
      circulatingSupply: row.asset.circulatingSupply,
      maxSupply: row.asset.maxSupply,
      quoteTime: row.asset.quoteTime,
      ...(kind === "stablecoin" ? {
        peg: row.peg,
        pegText: row.pegText || "—",
        offPegBp: row.offPegBp,
        low24h: row.low24h,
        low24hText: row.low24hText,
        low24hAt: row.low24hAt == null ? null : new Date(row.low24hAt).toISOString(),
        high24h: row.high24h,
        high24hText: row.high24hText,
        high24hAt: row.high24hAt == null ? null : new Date(row.high24hAt).toISOString(),
        supply: row.supply,
        supply7d: row.supply7d,
        supply7dPercent: row.supply7dPercent,
        supply30d: row.supply30d,
        supply30dPercent: row.supply30dPercent,
        supplyShare: row.supplyShare,
        pegType: row.pegType,
      } : {}),
    }));
    const metadata = { list: kind, status: data.status, asOf: data.asOf, generatedAt: data.generatedAt, changeBasis: CRYPTO_CHANGE_BASIS_LABEL };
    if (kind !== "stablecoin") return { rows, errors: data.warnings, metadata };
    const summary = supply ? supplySummaryLine(supply) : null;
    const history = supply ? supplyHistoryTable(supply) : null;
    // A supply outage is a caveat, not a failure: the prices are the report, and they are complete.
    const notes = [
      ...(supply?.warnings ?? []),
      ...(supplyResult && "error" in supplyResult
        ? [`${supplyFailure(errorMessage(supplyResult.error)).replace(/\.$/, "")}; the prices are complete without it.`]
        : []),
    ];
    return {
      rows,
      columns: supply?.coins.length ? STABLECOIN_SUPPLY_COLUMNS : STABLECOIN_COLUMNS,
      ...(history ? { exportTables: [history] } : {}),
      errors: data.warnings,
      ...(notes.length ? { notes } : {}),
      metadata: { ...metadata, ...(summary ? { notices: [summary] } : {}), ...(supply ? { supply: supplyMetadata(supply) } : {}) },
    };
  },
};
