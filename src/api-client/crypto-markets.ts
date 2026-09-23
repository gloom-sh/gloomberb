/** Completed UTC daily closes, oldest first, one slot per calendar day. */
export interface CryptoDailyCloses {
  start: string;
  closes: Array<number | null>;
}

export type CryptoAssetKind = "coin" | "stablecoin";

export interface CryptoMarketAsset {
  /** Quote symbol for streaming and the ticker pane, for example BTC-USD. */
  symbol: string;
  /** Display code, for example BTC. */
  code: string;
  name: string;
  kind: CryptoAssetKind;
  /** Market-cap rank within its kind. */
  rank: number;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume24h: number | null;
  marketCap: number | null;
  circulatingSupply: number | null;
  maxSupply: number | null;
  high52w: number | null;
  low52w: number | null;
  /** Price one year before the quote, so a live price can restate the 1Y return. */
  yearAgoPrice: number | null;
  quoteTime: string | null;
  history: CryptoDailyCloses | null;
}

export interface CryptoMarketsPayload {
  version: 1;
  generatedAt: string;
  asOf: string | null;
  status: "available" | "partial" | "unavailable";
  source: {
    name: string;
    url: string;
    screenerFetchedAt: string | null;
    historyFetchedAt: string | null;
  };
  assets: CryptoMarketAsset[];
  warnings: string[];
}
