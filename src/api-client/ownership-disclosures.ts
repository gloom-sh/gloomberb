import { hongKongListingCode, listingSuffixVenue } from "../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";

export interface OwnershipDisclosure {
  owner: string;
  role: string;
  date: string | null;
  dateBasis: "filing" | "event" | "month end" | "register" | null;
  kind: string;
  securities: number | null;
  change: number | null;
  pledged: number | null;
  percent: number | null;
  position?: "Long" | "Short" | "Lending pool";
  involved?: string;
  reason?: string;
  url: string;
}

export interface OwnershipDisclosures {
  listing: string;
  publisher: string;
  name: string;
  total: number;
  rows: OwnershipDisclosure[];
  registers: Array<{kind: "major" | "major-notices" | "insider"; total: number; status: "read" | "stale" | "unavailable"; retrievedAt: string | null; sourceCount?: number; url?: string}>;
}

export function disclosureListing(key?: string | null, exchange?: string) {
  if (!key) return null;
  const parsed = parsePublicTickerKey(key);
  const venue = parsed.exchange || canonicalExchange(exchange);
  const suffixed = listingSuffixVenue(parsed.symbol, venue);
  const symbol = suffixed?.symbol ?? parsed.symbol;
  const board = suffixed?.exchange ?? venue;
  if (["HKEX", "SEHK", "HKG"].includes(board) && /^0*[1-9]\d{0,3}$/.test(symbol)) {
    return hongKongListingCode(String(Number(symbol)), "HKEX") + ":HKEX";
  }
  return ["TWSE", "TPEX", "KRX", "KOSDAQ"].includes(board) && /^[0-9][0-9A-Z]{3,5}$/.test(symbol) ? symbol + ":" + board : null;
}
