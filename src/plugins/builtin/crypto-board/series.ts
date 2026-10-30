import type { SeriesDefinition, SeriesPoint } from "../../../series/types";
import { cachedSeriesNote } from "../shared/series-warning";
import { loadDefiTvl, loadStablecoinSupply, loadStablecoinSupplyHistory } from "./client";
import { BITCOIN_NETWORK_SERIES } from "./bitcoin-network";

const DAY_MS = 86_400_000;

/** Daily values from `start`, a missing day left a gap. */
function dailyPoints(start: string, values: ReadonlyArray<number | null>): SeriesPoint[] {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  return values.map((value, index) => ({ date: startMs + index * DAY_MS, value }));
}

/** The coin a pair names: USDT-USD charts USDT. */
function stablecoinSymbol(ticker: string): string {
  return ticker.trim().toUpperCase().split(/[-/]/)[0] ?? ticker;
}

/** Total stablecoin supply and any listed coin's, as CRYP's stablecoin list shows them. */
const STABLECOIN_SUPPLY_SERIES: readonly SeriesDefinition[] = [
  {
    id: "crypto:stablecoin-supply",
    name: "Total stablecoin supply",
    unit: "USD",
    frequency: "daily",
    group: "Crypto",
    tags: ["stablecoin", "stablecoins", "supply", "USDT", "USDC", "liquidity"],
    description: "Total supply of all stablecoins, valued in USD, daily since 2017, as CRYP's stablecoin list totals it.",
    load: async () => {
      const resource = await loadStablecoinSupply();
      const history = resource.payload.history;
      if (!history) throw new Error("Stablecoin supply is not available yet.");
      return { points: dailyPoints(history.start, history.total), ...cachedSeriesNote(resource) };
    },
  },
  {
    id: "crypto:stablecoin-coin-supply",
    name: "Stablecoin supply",
    unit: "USD",
    frequency: "daily",
    group: "Crypto",
    tags: ["stablecoin", "stablecoins", "supply", "circulating"],
    description: "One stablecoin's supply across chains, valued in USD, daily, for a coin on CRYP's stablecoin list (USDT-USD).",
    input: "crypto",
    load: async ({ ticker }) => {
      const resource = await loadStablecoinSupplyHistory(stablecoinSymbol(ticker!));
      const history = resource.payload.history;
      if (!history) throw new Error(`${resource.payload.symbol} supply history is not available yet.`);
      return { points: dailyPoints(history.start, history.values), ...cachedSeriesNote(resource) };
    },
  },
];

/** Total value locked in DeFi, as CRYP's DeFi tab charts it. */
const DEFI_TVL_SERIES: SeriesDefinition = {
  id: "crypto:defi-tvl",
  name: "Total DeFi TVL",
  unit: "USD",
  frequency: "daily",
  group: "Crypto",
  tags: ["defi", "tvl", "total value locked", "on-chain", "protocols", "chains"],
  description: "Total value locked in DeFi protocols across every chain, valued in USD, daily since 2018, as DefiLlama measures it and CRYP's DeFi tab charts it.",
  load: async () => {
    const resource = await loadDefiTvl();
    const history = resource.payload.history;
    if (!history) throw new Error("DeFi TVL is not available yet.");
    return { points: dailyPoints(history.start, history.total), ...cachedSeriesNote(resource) };
  },
};

const PAIRS: ReadonlyArray<{ symbol: string; name: string }> = [
  { symbol: "BTC-USD", name: "Bitcoin" },
  { symbol: "ETH-USD", name: "Ethereum" },
  { symbol: "SOL-USD", name: "Solana" },
  { symbol: "XRP-USD", name: "XRP" },
  { symbol: "BNB-USD", name: "BNB" },
  { symbol: "DOGE-USD", name: "Dogecoin" },
  { symbol: "ADA-USD", name: "Cardano" },
  { symbol: "AVAX-USD", name: "Avalanche" },
  { symbol: "LINK-USD", name: "Chainlink" },
  { symbol: "DOT-USD", name: "Polkadot" },
  { symbol: "LTC-USD", name: "Litecoin" },
  { symbol: "UNI-USD", name: "Uniswap" },
  { symbol: "ATOM-USD", name: "Cosmos" },
  { symbol: "NEAR-USD", name: "NEAR" },
  { symbol: "APT-USD", name: "Aptos" },
  { symbol: "SUI-USD", name: "Sui" },
  { symbol: "TON-USD", name: "Toncoin" },
  { symbol: "SHIB-USD", name: "Shiba Inu" },
];

/**
 * The large pairs by name, and the price of any pair: the board's sparklines
 * and the price a pair on the user's lists charts.
 */
export const CRYPTO_SERIES: readonly SeriesDefinition[] = [
  ...PAIRS.map((pair): SeriesDefinition => ({
    id: `crypto:${pair.symbol}`,
    name: `${pair.name} (${pair.symbol})`,
    unit: "USD",
    frequency: "intraday",
    group: "Crypto",
    tags: [pair.symbol.split("-")[0]!, "crypto", "coin"],
    expression: `${pair.symbol}:price`,
  })),
  {
    id: "crypto:price",
    name: "Price",
    unit: "currency",
    frequency: "intraday",
    group: "Crypto",
    tags: ["crypto", "pair"],
    input: "crypto",
    expression: "{ticker}:price",
  },
  ...STABLECOIN_SUPPLY_SERIES,
  DEFI_TVL_SERIES,
  ...BITCOIN_NETWORK_SERIES,
];
