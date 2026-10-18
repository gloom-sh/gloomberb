import type { CryptoAssetKind } from "../../../api-client/crypto-markets";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { fetchCryptoMarkets } from "./client";
import type { HeadlessPaneColumn } from "../../../types/headless";
import { buildCryptoRows, CRYPTO_BOARD_FRESHNESS, formatCryptoPercent, formatDayRangeTime, formatOffPeg } from "./model";

const NO_QUOTES = new Map();
const number = (value: unknown) => (typeof value === "number" ? value : null);
const percent = (value: unknown) => formatCryptoPercent(number(value));
const compact = (value: unknown) => (number(value) == null ? "—" : formatCompact(number(value)!, { fixedDecimals: true }));
const text = (key: string) => (_value: unknown, row: Record<string, unknown>) => String(row[key] ?? "—");
/** Exports keep the date; the text table reads `Sat 11:30`, the weekday enough inside 24 hours. */
const isoMinute = (value: unknown) => typeof value === "string" ? `${value.slice(0, 16).replace("T", " ")} UTC` : "";
const dayTime = (value: unknown) => formatDayRangeTime(typeof value === "string" ? Date.parse(value) : null);

const COIN_COLUMNS: HeadlessPaneColumn[] = [
  { key: "rank", header: "#", align: "right" },
  { key: "code", header: "Coin" },
  { key: "name", header: "Name" },
  { key: "price", header: "Price", align: "right", format: (_value, row) => String(row.priceText ?? "—") },
  { key: "changePercent", header: "Chg %", align: "right", format: percent },
  { key: "return7d", header: "7D %", align: "right", format: percent },
  { key: "return30d", header: "30D %", align: "right", format: percent },
  { key: "return1y", header: "1Y %", align: "right", format: percent },
  { key: "volume24h", header: "Vol 24h", align: "right", format: compact },
  { key: "marketCap", header: "Market cap", align: "right", format: compact },
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

export const cryptoBoardHeadless: HeadlessPaneDefinition<"rows"> = {
  shape: "rows",
  argument: { kind: "none" },
  options: [{
    key: "list",
    description: "Coins or stablecoins.",
    type: "enum",
    values: [
      { value: "coin", aliases: ["coins"] },
      { value: "stablecoin", aliases: ["stablecoins", "stable", "stables"] },
    ],
    defaultValue: "coin",
    example: "--list stablecoin",
    pluginState: { pluginId: "market-overview", key: "activeTab" },
  }],
  columns: COIN_COLUMNS,
  describe: (args) => `Crypto | ${args.options.list === "stablecoin" ? "Stablecoins" : "Coins"}`,
  discovery: {
    aliases: ["CRYP"],
    dataRequirements: ["Gloom Cloud crypto markets"],
  },
  // A board snapshot refreshed every few minutes; the pane streams, the report does not.
  freshness: { status: "delayed", ...CRYPTO_BOARD_FRESHNESS },
  async load(args, ctx) {
    const kind = args.options.list === "stablecoin" ? "stablecoin" : "coin" satisfies CryptoAssetKind;
    const data = await fetchCryptoMarkets(ctx.apiClient);
    const rows = buildCryptoRows(data.assets, kind, NO_QUOTES).map((row) => ({
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
      ...kind === "stablecoin" ? {
        peg: row.peg,
        pegText: row.pegText || "—",
        offPegBp: row.offPegBp,
        low24h: row.low24h,
        low24hText: row.low24hText,
        low24hAt: row.low24hAt == null ? null : new Date(row.low24hAt).toISOString(),
        high24h: row.high24h,
        high24hText: row.high24hText,
        high24hAt: row.high24hAt == null ? null : new Date(row.high24hAt).toISOString(),
      } : {},
    }));
    return {
      rows,
      ...kind === "stablecoin" ? { columns: STABLECOIN_COLUMNS } : {},
      errors: data.warnings,
      metadata: { list: kind, status: data.status, asOf: data.asOf, generatedAt: data.generatedAt },
    };
  },
};
