/**
 * Generic futures tickers (CL1, TY2F5R): a rolling series that follows the
 * nth listed contract of a root, not a tradeable contract. Gloom Cloud builds
 * them; the grammar mirrors its parser. After the root and position, F5 rolls
 * five business days before first notice (last trade for cash-settled roots),
 * D15 on the 15th, and without either the generic follows open interest. R
 * ratio-adjusts, A difference-adjusts, neither leaves prices as traded.
 */

import { parsePublicTickerKey } from "./exchanges";

export type FuturesGenericRoll =
  | { rule: "open-interest" }
  | { rule: "first-notice"; days: number }
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
  ["CME", ["ES", "NQ", "RTY", "6E", "6J", "6B", "6A", "6C", "6S", "SR3", "LE", "GF", "HE", "LBR", "DC", "CSC", "GD", "BTC", "ETH", "SOL", "XRP"]],
  ["CBT", ["YM", "ZT", "ZF", "ZN", "ZB", "UB", "ZQ", "ZC", "ZS", "ZW", "ZM", "ZL", "KE", "ZO", "ZR"]],
  ["NYM", ["CL", "BZ", "NG", "RB", "HO", "PL", "PA", "B0", "TTF"]],
  ["CMX", ["GC", "SI", "HG", "ALI", "HRC", "UX"]],
  ["NYB", ["KC", "SB", "CC", "CT", "OJ"]],
  ["CFE", ["VX"]],
] as const).flatMap(([venue, roots]) => roots.map((root) => [root, venue])));

/** Other names quotes give each venue, which a listing may carry as its exchange. */
const VENUE_NAMES: Readonly<Record<string, readonly string[]>> = {
  NYM: ["NYMEX", "NY MERCANTILE"], CBT: ["CBOT"], CMX: ["COMEX"], NYB: ["ICE FUTURES", "NYBOT"], CFE: ["CBOE FUTURES"],
};

/** Bloomberg's codes where they differ from the exchange's. */
const ALIASES: Readonly<Record<string, string>> = {
  TY: "ZN", US: "ZB", FV: "ZF", TU: "ZT", WN: "UB", DM: "YM", FF: "ZQ", SFR: "SR3",
  CO: "BZ", XB: "RB", LC: "LE", LH: "HE", FC: "GF", SM: "ZM", BO: "ZL", KW: "KE",
};

/** Roots whose contracts give first notice before last trade; the rest roll against last trade. */
const FIRST_NOTICE_ROOTS = new Set([
  "ZC", "ZS", "ZW", "ZM", "ZL", "KE", "ZO", "ZR", "GC", "SI", "HG", "PL", "PA", "ALI", "ZT", "ZF", "ZN", "ZB", "UB", "KC", "CC", "CT", "LE",
]);

export function parseFuturesGeneric(value: unknown): FuturesGeneric | null {
  if (typeof value !== "string") return null;
  const ticker = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) return null;
  for (let length = Math.min(4, ticker.length - 1); length >= 1; length -= 1) {
    const prefix = ticker.slice(0, length);
    const root = ALIASES[prefix] ?? prefix;
    if (!ROOT_VENUES[root]) continue;
    const match = /^(\d{1,2})(?:([FD])(\d{1,2}))?([RA])?$/.exec(ticker.slice(length));
    if (!match) continue;
    const position = Number(match[1]);
    if (match[1]!.startsWith("0") || position < 1 || position > 24) return null;
    const amount = match[3] == null ? 0 : Number(match[3]);
    const roll: FuturesGenericRoll = match[2] === "F" ? { rule: "first-notice", days: amount }
      : match[2] === "D" ? { rule: "fixed-day", day: amount } : { rule: "open-interest" };
    if (roll.rule === "first-notice" && roll.days > 30) return null;
    if (roll.rule === "fixed-day" && (roll.day < 1 || roll.day > 28)) return null;
    return { ticker, prefix, root, position, roll, adjust: match[4] === "R" ? "ratio" : match[4] === "A" ? "difference" : "none" };
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
  const venue = (key.exchange || exchange || "").trim().toUpperCase();
  const own = ROOT_VENUES[generic.root]!;
  return !venue || venue === own || VENUE_NAMES[own]?.includes(venue) ? generic : null;
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
  const rollCode = roll.rule === "first-notice" ? `F${roll.days}` : roll.rule === "fixed-day" ? `D${roll.day}` : "";
  return `${generic.prefix}${generic.position}${rollCode}${adjust === "ratio" ? "R" : adjust === "difference" ? "A" : ""}`;
}

export function futuresGenericOrdinal(position: number): string {
  const tens = position % 100;
  return `${position}${tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][position % 10] ?? "th"}`;
}

/**
 * How a generic's price reads: index and VIX futures in points (not dollars),
 * Treasury futures in 32nds of par; everything else in its quote currency.
 */
export function futuresGenericPriceBasis(generic: Pick<FuturesGeneric, "root">): "points" | "thirty-seconds" | null {
  if (["ES", "NQ", "RTY", "YM", "GD", "VX"].includes(generic.root)) return "points";
  if (["ZT", "ZF", "ZN", "ZB", "UB"].includes(generic.root)) return "thirty-seconds";
  return null;
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

export function futuresGenericAdjustLabel(adjust: FuturesGenericAdjust): string {
  return adjust === "ratio" ? "ratio adjusted" : adjust === "difference" ? "difference adjusted" : "unadjusted";
}

/** The legend caption: says it is a generic and how it rolls, so it is never read as one contract. */
export function futuresGenericCaption(generic: FuturesGeneric): string {
  return `${generic.ticker} ${futuresGenericOrdinal(generic.position)} generic · ${futuresGenericRollLabel(generic)} · ${futuresGenericAdjustLabel(generic.adjust)}`;
}

/** Choice values for the chart's roll control: the three rules at their usual settings. */
export function futuresGenericRollValue(roll: FuturesGenericRoll): string {
  return roll.rule === "first-notice" ? `f${roll.days}` : roll.rule === "fixed-day" ? `d${roll.day}` : "oi";
}

export function futuresGenericRollFromValue(value: string): FuturesGenericRoll | null {
  if (value === "oi") return { rule: "open-interest" };
  const match = /^([fd])(\d{1,2})$/.exec(value);
  if (!match) return null;
  return match[1] === "f" ? { rule: "first-notice", days: Number(match[2]) } : { rule: "fixed-day", day: Number(match[2]) };
}
