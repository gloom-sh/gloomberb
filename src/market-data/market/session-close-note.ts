import { canonicalExchange } from "../../utils/exchanges";
import { futuresListingVenue } from "../../utils/futures-generic";
import { regularSessionCloseUtcMinute } from "./freshness";
import { PERPETUAL_EXCHANGES } from "../../tickers/perpetual-listing";
import { futuresContractByCode } from "../futures-board";
import { zonedWallClockToUtcMs } from "../../utils/zoned-date-time";

interface SessionLeg {
  symbol: string;
  /** The listing's exchange; without one the close is unknown and no note is made. */
  exchange?: string;
  /** What the reader typed, when it differs from the symbol. */
  label?: string;
}

const MINUTES_PER_DAY = 1440;
/** Crypto, FX and perpetual futures carry no regular session. */
const ALWAYS_OPEN_EXCHANGES = new Set(["CCC", "CCY", ...PERPETUAL_EXCHANGES]);

const clock = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function offsetText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} h` : "", rest ? `${rest} min` : ""].filter(Boolean).join(" ");
}

/** Metals settle at their own times, New York minutes: gold 13:30, silver 13:25, platinum 13:05, copper and palladium 13:00. */
const METAL_SETTLEMENTS: Readonly<Record<string, number>> = {
  GC: 13 * 60 + 30, MGC: 13 * 60 + 30, SI: 13 * 60 + 25, SIL: 13 * 60 + 25, PL: 13 * 60 + 5, HG: 13 * 60, PA: 13 * 60,
};

/**
 * When a future's daily settlement is taken, in New York minutes: the time
 * its daily bar closes on, whatever the bar is stamped. From CME Group's and
 * Cboe's settlement procedures: energy 14:30 (NYMEX), grains 14:15 (13:15
 * Chicago), livestock 14:05, Treasuries and currencies 15:00, equity index
 * and VIX futures 16:00. Null for a root whose time is not listed here
 * (Dutch TTF, the ICE softs, lumber, aluminum), whose bar is read as stamped.
 */
function futuresSettlementMinute(root: string | null): number | null {
  if (!root) return null;
  if (METAL_SETTLEMENTS[root] !== undefined) return METAL_SETTLEMENTS[root]!;
  const contract = futuresContractByCode(root);
  switch (contract?.sector) {
    case "energy": return contract.code === "TTF" ? null : 14 * 60 + 30;
    case "agriculture": return contract.venue === "CBT" ? 14 * 60 + 15 : null;
    case "livestock": return 14 * 60 + 5;
    case "rates": case "currencies": return 15 * 60;
    case "equity-index": case "equity-sectors": case "volatility": return 16 * 60;
    default: return null;
  }
}

/**
 * Where a daily bar of the listing falls on its date. A venue with a listed
 * regular close closes at that UTC time, and a future at its settlement.
 * Crypto, FX and a future whose settlement time is not listed carry a bar
 * dated 00:00 UTC, which closes when the next UTC day starts. A venue with
 * neither is unknown.
 */
function dailyBarClose(leg: SessionLeg, time: number): { minute: number; text: string } | null {
  const label = leg.label ?? leg.symbol;
  const minute = regularSessionCloseUtcMinute(leg.exchange, time);
  if (minute !== null) return { minute, text: `${label} closes ${clock(minute)} UTC` };
  const exchange = canonicalExchange(leg.exchange);
  if (!exchange) return null;
  const future = futuresListingVenue(leg.symbol, exchange);
  const settles = future ? futuresSettlementMinute(future.root) : null;
  if (settles != null) {
    const day = new Date(time).toISOString().slice(0, 10).split("-").map(Number);
    const at = zonedWallClockToUtcMs("America/New_York", day[0]!, day[1]!, day[2]!, Math.floor(settles / 60), settles % 60, 0);
    const utc = Math.floor(at / 60_000) % MINUTES_PER_DAY;
    return { minute: utc, text: `${label} settles ${clock(utc)} UTC` };
  }
  return future || ALWAYS_OPEN_EXCHANGES.has(exchange) ? { minute: MINUTES_PER_DAY, text: `${label} bar is ${clock(0)} UTC` } : null;
}

/**
 * One line for a daily pair whose two sides close at different times, such as
 * a US equity against crypto, or null when they close together (two US
 * equities) or a close is not known. Daily closes pair by UTC date, so a
 * reader of a correlation or ratio should know the two prices are not taken
 * at the same moment. `dateKey` is the date the pair is read on, which
 * settles daylight time.
 */
export function mixedSessionCloseNote(left: SessionLeg, right: SessionLeg, dateKey?: string | null): string | null {
  const parsed = dateKey ? Date.parse(`${dateKey}T23:59:59Z`) : Number.NaN;
  const time = Number.isFinite(parsed) ? parsed : Date.now();
  const a = dailyBarClose(left, time);
  const b = dailyBarClose(right, time);
  if (!a || !b) return null;
  const offset = Math.abs(a.minute - b.minute);
  return offset === 0 ? null : `${a.text}; ${b.text} (${offsetText(offset)} offset). Daily pairs are matched by date.`;
}
