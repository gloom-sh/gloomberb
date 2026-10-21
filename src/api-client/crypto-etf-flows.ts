/** A spot crypto ETF asset whose daily flows Gloom Cloud serves. */
export type CryptoEtfFlowAsset = "BTC" | "ETH";

interface CryptoEtfFlowFund {
  ticker: string;
  /** The fund's name and issuer where Gloom lists the fund; null for a ticker it does not. */
  name: string | null;
  issuer: string | null;
}

export interface CryptoEtfFlowDay {
  /** The US trading day, YYYY-MM-DD. */
  date: string;
  /** Each fund's net flow that day in US$ millions; null where the publisher shows none. */
  flows: Record<string, number | null>;
  /** The day's total as published. */
  total: number | null;
  /** Funds that reported the day before but show no figure yet. */
  pending: string[];
}

/** `GET /cloud/crypto/etf-flows?asset=btc|eth`: daily net flows of the US spot funds. */
export interface CryptoEtfFlowsPayload {
  asset: CryptoEtfFlowAsset;
  unit: "USD millions";
  /** The funds in the publisher's order. */
  funds: CryptoEtfFlowFund[];
  /** Newest day first. */
  days: CryptoEtfFlowDay[];
  /** The newest day listed. */
  asOf: string;
  source: { publisher: string; url: string };
  /** When the publisher's table was last read. */
  fetchedAt: string;
  /** No read has succeeded for two days. */
  stale: boolean;
}
