import type { IssuerListings } from "../types/issuer-listings";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import { hongKongListingCode, listingSuffixCandidate } from "../sources/listing-symbols";
import { pricesTimingNote, type PairPriceInput } from "./depositary-pair";

/**
 * A company listed twice in China: its A shares in Shanghai or Shenzhen, in
 * yuan, and its H shares in Hong Kong, in Hong Kong dollars (China Shenhua's
 * 601088:SSE and 1088:HKEX, CATL's 300750:SZSE and 3750:HKEX). The two are
 * one class of the company's shares, so the H price against the A price at
 * spot is the A/H premium a Hong Kong desk quotes: on 17 Nov 2026 CATL's H
 * shares closed at HK$366.80 against CN¥238.50 for its A shares, HK$280.80 at
 * 1.1772 Hong Kong dollars a yuan, the H shares about 31% over the A.
 */
export interface AhPair {
  /** The H share line, `1088:HKEX`. */
  h: string;
  /** The A share line, `601088:SSE`. */
  a: string;
}

const A_SHARE_VENUES = new Set(["SSE", "SZSE"]);

/**
 * A listing of the company universe as a key: `1088:HKEX`, `601088:SSE`. A
 * Hong Kong code in the five digits HKEX writes it in (`01211`, as a ticker
 * may be saved) is the four-digit line the company universe lists (`1211`).
 */
function listingKey(line: { symbol: string; exchange: string }): string {
  const { symbol, exchange } = parsePublicTickerKey(line.symbol);
  const venue = canonicalExchange(exchange ?? line.exchange);
  const code = venue === "HKEX" && /^0\d{4}$/.test(symbol) ? symbol.slice(1) : symbol;
  return `${hongKongListingCode(code, venue)}:${venue}`;
}

/**
 * The A and H lines of the company Gloom Cloud's company universe holds them
 * for: exactly one line in Hong Kong and one in Shanghai or Shenzhen. Null for
 * any other company, and for one with more lines there than one of each.
 */
export function ahPairOf(issuer: Pick<IssuerListings, "listings"> | null | undefined): AhPair | null {
  const lines = issuer?.listings ?? [];
  const h = lines.filter((line) => canonicalExchange(line.exchange) === "HKEX");
  const a = lines.filter((line) => A_SHARE_VENUES.has(canonicalExchange(line.exchange)));
  return h.length === 1 && a.length === 1 ? { h: listingKey(h[0]!), a: listingKey(a[0]!) } : null;
}

/**
 * A listing as the pair writes its lines: `1088:HKEX` for 1088 on HKEX,
 * `1088.HK` or `1088:HKEX`, the venue read from the key, a vendor's suffix or
 * `exchange`.
 */
export function ahListingKey(symbol: string, exchange?: string | null): string {
  const parsed = parsePublicTickerKey(symbol);
  const suffixed = parsed.exchange ? null : listingSuffixCandidate(parsed.symbol);
  return listingKey({ symbol: suffixed?.symbol ?? parsed.symbol, exchange: canonicalExchange(parsed.exchange ?? suffixed?.exchange ?? exchange ?? "") });
}

/** Venues whose own lists state a line's board lot, which the company universe serves with its listings. */
const BOARD_LOT_VENUES: ReadonlySet<string> = new Set(["HKEX", "SGX"]);

/** Whether a listing trades on a venue that states its board lot (`BOARD_LOT_VENUES`), so its company's listings are worth reading for it. */
export function statesBoardLot(symbol: string | null | undefined, exchange?: string | null): boolean {
  return !!symbol && BOARD_LOT_VENUES.has(parsePublicTickerKey(ahListingKey(symbol, exchange)).exchange ?? "");
}

/**
 * The shares one lot of a listing trades in, as its company's listings carry
 * it: 500 for Zijin Mining's 2899:HKEX, 400 for HSBC's 0005:HKEX. Null where
 * the listing is not among them or its lot is not a positive whole number.
 */
export function listingBoardLot(issuer: Pick<IssuerListings, "listings"> | null | undefined, symbol: string, exchange?: string | null): number | null {
  const key = ahListingKey(symbol, exchange);
  const lot = issuer?.listings.find((line) => listingKey(line) === key)?.boardLot;
  return typeof lot === "number" && Number.isSafeInteger(lot) && lot > 0 ? lot : null;
}

/** Which line of the pair a listing is (`ahListingKey`); null for neither. */
export function ahPairSide(pair: AhPair, symbol: string, exchange?: string | null): "h" | "a" | null {
  const key = ahListingKey(symbol, exchange);
  return key === pair.h ? "h" : key === pair.a ? "a" : null;
}

/** Hong Kong dollars a yuan, from each currency's dollar value as exchange rates are served, and when it was read. */
export interface AhSpot {
  rate: number;
  observedAt: number | null;
}

/**
 * The rate from each currency's US dollar value (dollars a unit), as exchange
 * rates are served and observed (`asOf`), dated by the older of the two reads.
 * Null without both.
 */
export function ahSpotFromUsdValues(
  cny: { rate: number | null | undefined; asOf?: number | null } | null | undefined,
  hkd: { rate: number | null | undefined; asOf?: number | null } | null | undefined,
): AhSpot | null {
  const yuan = cny?.rate;
  const dollar = hkd?.rate;
  if (yuan == null || dollar == null || !(yuan > 0) || !(dollar > 0) || !Number.isFinite(yuan / dollar)) return null;
  const times = [cny?.asOf, hkd?.asOf].filter((time): time is number => time != null && Number.isFinite(time));
  return { rate: yuan / dollar, observedAt: times.length === 2 ? Math.min(...times) : null };
}

export interface AhComparison {
  h: PairPriceInput;
  a: PairPriceInput;
  spot: AhSpot | null;
  /** The A price in Hong Kong dollars at spot. */
  aInHkd: number | null;
  /** The H price over the A price at spot, in percent: H / (A × spot) - 1. */
  premiumPercent: number | null;
  /** Said when the two prices were not set together; null when they were. */
  timingNote: string | null;
}

/** The comparison, or null without both prices, each in its own currency (HKD and CNY). */
export function compareAhPair(h: PairPriceInput | null, a: PairPriceInput | null, spot: AhSpot | null, now = Date.now()): AhComparison | null {
  if (!h || !a || h.currency !== "HKD" || a.currency !== "CNY") return null;
  const aInHkd = spot ? a.price * spot.rate : null;
  const premiumPercent = aInHkd != null && aInHkd > 0 ? (h.price / aInHkd - 1) * 100 : null;
  return { h, a, spot, aInHkd, premiumPercent, timingNote: pricesTimingNote(a, h, now) };
}

/** `CNY/HKD`: Hong Kong dollars a yuan, as `fx` names the pair. */
export const AH_SPOT_LABEL = "CNY/HKD";
