import type { SeriesDefinition } from "../../../series/types";

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
];
