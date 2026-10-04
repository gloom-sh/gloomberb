import type { CryptoAssetKind } from "../../../api-client/crypto-markets";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { formatCompact } from "../../../utils/format";
import { fetchCryptoMarkets } from "./client";
import { buildCryptoRows, formatCryptoPercent } from "./model";

const NO_QUOTES = new Map();
const number = (value: unknown) => (typeof value === "number" ? value : null);
const percent = (value: unknown) => formatCryptoPercent(number(value));
const compact = (value: unknown) => (number(value) == null ? "—" : formatCompact(number(value)!, { fixedDecimals: true }));

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
    pluginState: { pluginId: "market-overview", key: "activeTab" },
  }],
  columns: [
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
  ],
  describe: (args) => `Crypto | ${args.options.list === "stablecoin" ? "Stablecoins" : "Coins"}`,
  discovery: {
    aliases: ["CRYP"],
    dataRequirements: ["Gloom Cloud crypto markets"],
  },
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
    }));
    return {
      rows,
      errors: data.warnings,
      metadata: { list: kind, status: data.status, asOf: data.asOf, generatedAt: data.generatedAt },
    };
  },
};
