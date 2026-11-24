import { listingSuffixVenue } from "../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";

export interface OwnershipDisclosure {
  owner: string;
  role: string;
  date: string;
  dateBasis: "filing" | "month end" | "register";
  kind: string;
  securities: number | null;
  change: number | null;
  pledged: number | null;
  percent: number | null;
  reason?: string;
  url: string;
}

export interface OwnershipDisclosures {
  listing: string;
  publisher: string;
  name: string;
  total: number;
  rows: OwnershipDisclosure[];
  registers: Array<{kind: "major" | "insider"; total: number; status: "read" | "stale" | "unavailable"; retrievedAt: string | null}>;
}

export function disclosureListing(key?: string | null, exchange?: string) {
  if (!key) return null;
  const parsed = parsePublicTickerKey(key);
  const venue = parsed.exchange || canonicalExchange(exchange);
  const suffixed = listingSuffixVenue(parsed.symbol, venue);
  const symbol = suffixed?.symbol ?? parsed.symbol;
  const board = suffixed?.exchange ?? venue;
  return ["TWSE", "TPEX", "KRX", "KOSDAQ"].includes(board) && /^[0-9][0-9A-Z]{3,5}$/.test(symbol) ? symbol + ":" + board : null;
}
