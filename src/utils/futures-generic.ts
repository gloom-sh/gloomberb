/**
 * Generic futures tickers (CL1, TY2F5R): a rolling series that follows the
 * nth listed contract of a root, not a tradeable contract. Gloom Cloud builds
 * them; the grammar mirrors its parser. After the root and position, F5 rolls
 * five business days before first notice (last trade for cash-settled roots),
 * D15 on the 15th, OI on the open interest switch, and without any the root's
 * standard roll, which the continuous alias (CL=F) follows too. R
 * ratio-adjusts, A difference-adjusts, neither leaves prices as traded.
 */

import { canonicalExchange, parsePublicTickerKey } from "./exchanges";

export type FuturesGenericRoll =
  | { rule: "open-interest" }
  | { rule: "first-notice"; days: number; standard?: true }
  | { rule: "fixed-day"; day: number };

export type FuturesGenericAdjust = "none" | "ratio" | "difference";

export interface FuturesGeneric {
  ticker: string;
  /** The root as typed, which may be a Bloomberg alias (TY for ZN). */
  prefix: string;
  root: string;
  position: number;
  roll: FuturesGenericRoll;
  adjust: FuturesGenericAdjust;
}

/** Roots Gloom Cloud archives daily, by the venue that lists them. */
const ROOT_VENUES: Readonly<Record<string, string>> = Object.fromEntries(([
  ["CME", ["ES", "NQ", "RTY", "EMD", "RS1", "NKD", "NIY", "MES", "MNQ", "M2K",
    "XAE", "XAB", "XAI", "XAY", "XAP", "XAV", "XAF", "XAK", "XAZ", "XAU", "XAR", "SXO", "SXR", "SXT", "SXB", "SXI", "SOX",
    "6E", "6J", "6B", "6A", "6C", "6S", "SR3", "LE", "GF", "HE", "LBR", "DC", "CSC", "GD", "BTC", "ETH", "SOL", "XRP"]],
  ["CBT", ["YM", "MYM", "RX", "ZT", "ZF", "ZN", "ZB", "UB", "ZQ", "ZC", "ZS", "ZW", "ZM", "ZL", "KE", "ZO", "ZR"]],
  ["NYM", ["CL", "QM", "MCL", "BZ", "NG", "QG", "MNG", "HH", "RB", "HO", "PL", "PA", "B0", "TTF"]],
  ["CMX", ["GC", "SI", "HG", "ALI", "HRC", "UX"]],
  ["NYB", ["KC", "SB", "CC", "CT", "OJ"]],
  ["CFE", ["VX"]],
] as const).flatMap(([venue, roots]) => roots.map((root) => [root, venue])));

/** Bloomberg's codes where they differ from the exchange's. */
const ALIASES: Readonly<Record<string, string>> = {
  TY: "ZN", US: "ZB", FV: "ZF", TU: "ZT", WN: "UB", DM: "YM", FF: "ZQ", SFR: "SR3",
  CO: "BZ", XB: "RB", LC: "LE", LH: "HE", FC: "GF", SM: "ZM", BO: "ZL", KW: "KE",
};

/** Roots whose contracts give first notice before last trade; the rest roll against last trade. */
const FIRST_NOTICE_ROOTS = new Set([
  "ZC", "ZS", "ZW", "ZM", "ZL", "KE", "ZO", "ZR", "GC", "SI", "HG", "PL", "PA", "ALI", "ZT", "ZF", "ZN", "ZB", "UB", "KC", "CC", "CT", "LE",
]);

/**
 * Business days before first notice (last trade where none comes first) a
 * root's standard roll leaves a contract, as Gloom Cloud counts them: six for
 * equity index, sector and currency futures (CME's quarterly roll date); two
 * for WTI crude and Henry Hub gas, whose mini and micro contracts stop a day
 * earlier, so the family rolls together; none for VX (it holds its contract
 * through expiry); one for every other root.
 */
const STANDARD_ROLL_DAYS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(["ES", "NQ", "RTY", "EMD", "RS1", "NKD", "NIY", "MES", "MNQ", "M2K", "YM", "MYM", "RX",
    "XAE", "XAB", "XAI", "XAY", "XAP", "XAV", "XAF", "XAK", "XAZ", "XAU", "XAR", "SXO", "SXR", "SXT", "SXB", "SXI", "SOX",
    "6E", "6J", "6B", "6A", "6C", "6S"].map((root) => [root, 6])),
  CL: 2,
  NG: 2,
  HH: 2,
  VX: 0,
};

/** A root's standard roll: what a bare generic (NG1) and the continuous alias (NG=F) follow. */
export function standardFuturesGenericRoll(root: string): FuturesGenericRoll {
  return { rule: "first-notice", days: STANDARD_ROLL_DAYS[root] ?? 1, standard: true };
}

export function parseFuturesGeneric(value: unknown): FuturesGeneric | null {
  if (typeof value !== "string") return null;
  const ticker = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) return null;
  for (let length = Math.min(4, ticker.length - 1); length >= 1; length -= 1) {
    const prefix = ticker.slice(0, length);
    const root = ALIASES[prefix] ?? prefix;
    if (!ROOT_VENUES[root]) continue;
    const match = /^(\d{1,2})(?:([FD])(\d{1,2})|(OI))?([RA])?$/.exec(ticker.slice(length));
    if (!match) continue;
    const position = Number(match[1]);
    if (match[1]!.startsWith("0") || position < 1 || position > 24) return null;
    const amount = match[3] == null ? 0 : Number(match[3]);
    const roll: FuturesGenericRoll = match[2] === "F" ? { rule: "first-notice", days: amount }
      : match[2] === "D" ? { rule: "fixed-day", day: amount } : match[4] ? { rule: "open-interest" } : standardFuturesGenericRoll(root);
    if (roll.rule === "first-notice" && roll.days > 30) return null;
    if (roll.rule === "fixed-day" && (roll.day < 1 || roll.day > 28)) return null;
    return { ticker, prefix, root, position, roll, adjust: match[5] === "R" ? "ratio" : match[5] === "A" ? "difference" : "none" };
  }
  return null;
}

/**
 * A listing that is a generic: the symbol parses and its exchange is empty or
 * the root's own venue, as Gloom Cloud decides, so a security elsewhere that
 * happens to spell like one (PL8 on the ASX) is never captioned or rolled as one.
 */
export function futuresGenericListing(symbol: string, exchange?: string | null): FuturesGeneric | null {
  const key = parsePublicTickerKey(symbol);
  const generic = parseFuturesGeneric(key.symbol);
  if (!generic) return null;
  // The alias table names each venue by its code, however a quote spells it (NYMEX is NYM).
  const venue = key.exchange || canonicalExchange(exchange ?? "");
  return !venue || venue === ROOT_VENUES[generic.root] ? generic : null;
}

const FUTURES_VENUES = new Set(Object.values(ROOT_VENUES));

/**
 * The futures venue and contract root of a listing: a continuous contract
 * (`ES=F`), a dated one (`CLZ26.NYM`), a generic (`CL1`) or the dollar index
 * (`DX-Y.NYB`), on its venue's code or any name quotes give it. Null for a
 * listing on a venue that is not one of the futures exchanges.
 */
export function futuresListingVenue(symbol: string, exchange?: string | null): { venue: string; root: string | null } | null {
  const ticker = symbol.trim().toUpperCase();
  const named = canonicalExchange(exchange ?? "");
  const venue = FUTURES_VENUES.has(named) ? named : null;
  const coded = /^([A-Z0-9]{1,4}?)(?:=F|[FGHJKMNQUVXZ]\d{2}(?:\.[A-Z]+)?)$/.exec(ticker)?.[1]
    ?? /^([A-Z]{2})-Y\.[A-Z]+$/.exec(ticker)?.[1];
  const root = futuresGenericListing(ticker, venue ?? named)?.root ?? (coded ? ALIASES[coded] ?? coded : null);
  if (venue) return { venue, root };
  // Without a futures exchange, only a symbol that is plainly a contract names one.
  return !named && root && ROOT_VENUES[root] && (coded || futuresGenericListing(ticker)) ? { venue: ROOT_VENUES[root]!, root } : null;
}

/**
 * Whether two listings are the same generic under any roll rule or adjustment
 * (CL1 and CL1F5R, TY1 and ZN1). The chart's Roll and Adjust controls rewrite
 * the ticker, and what it follows must not rewrite it back.
 */
export function isSameFuturesGeneric(
  a: { symbol: string; exchange?: string | null },
  b: { symbol: string; exchange?: string | null },
): boolean {
  const left = futuresGenericListing(a.symbol, a.exchange);
  const right = futuresGenericListing(b.symbol, b.exchange);
  return !!left && !!right && left.root === right.root && left.position === right.position;
}

export function formatFuturesGeneric(generic: Pick<FuturesGeneric, "prefix" | "position" | "roll" | "adjust">): string {
  const { roll, adjust } = generic;
  const rollCode = roll.rule === "first-notice" ? roll.standard ? "" : `F${roll.days}` : roll.rule === "fixed-day" ? `D${roll.day}` : "OI";
  return `${generic.prefix}${generic.position}${rollCode}${adjust === "ratio" ? "R" : adjust === "difference" ? "A" : ""}`;
}

function futuresGenericOrdinal(position: number): string {
  const tens = position % 100;
  return `${position}${tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][position % 10] ?? "th"}`;
}

/** Equity index, sector and industry futures, the S&P GSCI and VIX: their prices are index points. */
const POINT_ROOTS: ReadonlySet<string> = new Set(["ES", "NQ", "RTY", "YM", "GD", "VX", "EMD", "RS1", "NKD", "NIY", "MES", "MNQ", "M2K", "MYM", "RX",
  "XAE", "XAB", "XAI", "XAY", "XAP", "XAV", "XAF", "XAK", "XAZ", "XAU", "XAR", "SXO", "SXR", "SXT", "SXB", "SXI", "SOX"]);

/**
 * How a generic's price reads: index and VIX futures in points (not dollars),
 * Treasury futures in 32nds of par; everything else in its quote currency.
 */
export function futuresGenericPriceBasis(generic: Pick<FuturesGeneric, "root">): "points" | "thirty-seconds" | null {
  if (POINT_ROOTS.has(generic.root)) return "points";
  if (["ZT", "ZF", "ZN", "ZB", "UB"].includes(generic.root)) return "thirty-seconds";
  return null;
}

/**
 * How a futures listing's price reads, whichever form it takes: a generic by
 * its root (VX1 points, TY1 32nds), and a continuous (`ES=F`, `SXO=F`) or
 * listed contract (`SXOZ26.CME`) of an index, sector or industry root in index
 * points, on the root's own venue or with none. The quote keeps its currency
 * for what a tick is worth. Null for every other listing, a security that
 * shares a root's code on another venue (XAU on Toronto, the XAR ETF) included.
 */
export function futuresListingPriceBasis(symbol: string, exchange?: string | null): "points" | "thirty-seconds" | null {
  const generic = futuresGenericListing(symbol, exchange);
  if (generic) return futuresGenericPriceBasis(generic);
  const listing = futuresListingVenue(symbol, exchange);
  return listing?.root && ROOT_VENUES[listing.root] === listing.venue && POINT_ROOTS.has(listing.root) ? "points" : null;
}

/** Whether a root's date rules count back from first notice or from last trade. */
export function futuresGenericNotice(root: string): "first notice" | "last trade" {
  return FIRST_NOTICE_ROOTS.has(root) ? "first notice" : "last trade";
}

export function futuresGenericRollLabel(generic: Pick<FuturesGeneric, "root" | "roll">): string {
  const { roll } = generic;
  if (roll.rule === "open-interest") return "open interest switch";
  if (roll.rule === "fixed-day") return `fixed day ${roll.day}`;
  const notice = futuresGenericNotice(generic.root);
  if (roll.days === 0) return notice === "first notice" ? "on first notice" : "after last trade";
  return `${roll.days} ${roll.days === 1 ? "day" : "days"} before ${notice}`;
}

function futuresGenericAdjustLabel(adjust: FuturesGenericAdjust): string {
  return adjust === "ratio" ? "ratio adjusted" : adjust === "difference" ? "difference adjusted" : "unadjusted";
}

/** The legend caption: says it is a generic and how it rolls, so it is never read as one contract. */
export function futuresGenericCaption(generic: FuturesGeneric): string {
  return `${generic.ticker} ${futuresGenericOrdinal(generic.position)} generic · ${futuresGenericRollLabel(generic)} · ${futuresGenericAdjustLabel(generic.adjust)}`;
}

/** Choice values for the chart's roll control: the standard roll and the three rules at their usual settings. */
export function futuresGenericRollValue(roll: FuturesGenericRoll): string {
  if (roll.rule === "first-notice" && roll.standard) return "standard";
  return roll.rule === "first-notice" ? `f${roll.days}` : roll.rule === "fixed-day" ? `d${roll.day}` : "oi";
}

export function futuresGenericRollFromValue(value: string, root: string): FuturesGenericRoll | null {
  if (value === "standard") return standardFuturesGenericRoll(root);
  if (value === "oi") return { rule: "open-interest" };
  const match = /^([fd])(\d{1,2})$/.exec(value);
  if (!match) return null;
  return match[1] === "f" ? { rule: "first-notice", days: Number(match[2]) } : { rule: "fixed-day", day: Number(match[2]) };
}
