import { ApiRequestError } from "../../../api-client/errors";
import {
  BOND_HISTORY_MAX_DAYS,
  type StoredBondDay,
  type StoredBondPayload,
  type StoredBondPrint,
} from "../../../api-client/bond-trades";
import type { apiClient } from "../../../api-client";
import { signalWithTimeout } from "../../../utils/async-deadline";
import { formatCompact, MISSING_VALUE } from "../../../utils/format";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import type { BondQuery } from "./client";
import type { TimeSeriesPoint } from "../../../time-series/types";

const TAPE_TIME_ZONE = "America/New_York";
const DAY_MS = 86_400_000;
/** How long a ticker's lookup waits for its bonds to be kept. */
const ISSUER_KEEP_TIMEOUT_MS = 5_000;
/** Prints a history read lists, newest first. */
const STORED_PRINTS_LIMIT = 200;

export type StoredBondClient = Pick<typeof apiClient, "getCloudStoredBond" | "getCloudStoredIssuerBonds">;

/** How far back the daily closes reach: their own range, at most the 1,100 days a read takes. */
export const HISTORY_RANGES = [
  { value: "1M", days: 31 },
  { value: "3M", days: 92 },
  { value: "1Y", days: 366 },
  { value: "3Y", days: BOND_HISTORY_MAX_DAYS },
] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number]["value"];

/** The days a read asks for: `days` up to today in New York, the tape's calendar. */
function storedHistoryWindow(now = Date.now(), days: number = BOND_HISTORY_MAX_DAYS): { from: string; to: string } {
  const to = zonedDateKey(now, TAPE_TIME_ZONE);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (Math.min(days, BOND_HISTORY_MAX_DAYS) - 1) * DAY_MS)
    .toISOString().slice(0, 10);
  return { from, to };
}

/**
 * Since when a bond's prints are held: `Kept since 2023-11-03.`, and while
 * the source's earlier prints are still to be read, that they are. Null
 * before any day was read.
 */
export function keptSinceText(payload: Pick<StoredBondPayload, "keptSince" | "backfillPending">): string | null {
  if (!payload.keptSince) return null;
  return payload.backfillPending
    ? `Kept since ${payload.keptSince}; earlier prints are still being read.`
    : `Kept since ${payload.keptSince}.`;
}

/** Trades and corrections no cancel names: the prints a history lists. A cancel and what it cancelled say nothing about the price. */
export function standingPrints(prints: readonly StoredBondPrint[]): StoredBondPrint[] {
  return prints.filter((print) => print.status !== "cancel" && !print.cancelled);
}

/** Days with a price, oldest first: what the chart draws. */
export function pricedDays(days: readonly StoredBondDay[]): StoredBondDay[] {
  return days.filter((day) => day.price != null);
}

/** Three weeks without a sale breaks the line instead of drawing prices nobody paid. */
const CHART_GAP_MS = 21 * DAY_MS;

/** The daily closes as the chart's points, oldest first, with a break across a long gap between sales. */
export function bondPricePoints(days: readonly StoredBondDay[]): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  let previous: number | null = null;
  for (const day of pricedDays(days)) {
    const time = Date.parse(`${day.date}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    if (previous !== null && time - previous > CHART_GAP_MS) {
      const gap = new Date(previous + DAY_MS);
      points.push({ date: gap, observedAt: gap, value: null });
    }
    const date = new Date(time);
    points.push({ date, observedAt: date, value: day.price });
    previous = time;
  }
  return points;
}

/** Par amount as published: `250K`, `1M+` where only a floor is published. */
export function formatPrintSize(print: Pick<StoredBondPrint, "quantity" | "quantityCapped">): string {
  if (print.quantity == null) return MISSING_VALUE;
  return `${formatCompact(print.quantity)}${print.quantityCapped ? "+" : ""}`;
}

/** The side the reporting dealer took. */
export function formatPrintSide(side: StoredBondPrint["side"]): string {
  return side === "buy" ? "Buy" : side === "sell" ? "Sell" : MISSING_VALUE;
}

/** What a kept history says to an account without Gloom Pro. */
export const PRO_HISTORY_TEXT = "Kept price history needs Gloom Pro.";

/**
 * Why a kept history could not be read, in the words the pane and `fn`
 * show, or null for a failure worth reporting as one: the history is Gloom
 * Pro, and a bond the store cannot tie to a company has none.
 */
export function storedHistoryRefusal(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.status === 401 || error.status === 403) return PRO_HISTORY_TEXT;
  if (error.status === 404) return "No kept price history for this bond.";
  return null;
}

/** A bond's kept history for the pane, or why there is none to read; any other failure is thrown. */
export async function loadStoredBond(
  cusip: string,
  client: Pick<StoredBondClient, "getCloudStoredBond">,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<{ history: StoredBondPayload | null; refusal: string | null }> {
  try {
    const history = await client.getCloudStoredBond(cusip, { ...storedHistoryWindow(options.now), limit: STORED_PRINTS_LIMIT }, { signal: options.signal });
    return { history, refusal: null };
  } catch (error) {
    const refusal = storedHistoryRefusal(error);
    if (!refusal) throw error;
    return { history: null, refusal };
  }
}

/**
 * What a TRACE lookup reads of the kept history: one bond's, by its CUSIP;
 * for a ticker, its company's bonds are kept from now on (no history is
 * shown for them until one is opened). Null for a market-wide tape or a
 * name the store cannot read.
 */
export async function readStoredHistory(
  query: BondQuery | null,
  client: StoredBondClient,
  options: { signal?: AbortSignal; days?: number; now?: number } = {},
): Promise<StoredBondPayload | null> {
  if (!query) return null;
  if (query.kind === "cusip") {
    return client.getCloudStoredBond(query.cusip, {
      ...storedHistoryWindow(options.now, options.days),
      limit: STORED_PRINTS_LIMIT,
    }, { signal: options.signal });
  }
  // Asked so its bonds are kept, never waited on for long: the tape is the answer here.
  if (query.ticker) {
    const ticker = query.ticker;
    await Promise.resolve()
      .then(() => client.getCloudStoredIssuerBonds(ticker, { signal: signalWithTimeout(options.signal, ISSUER_KEEP_TIMEOUT_MS) }))
      .catch(() => {
        // Intentional ignore: keeping a company's bonds never changes the tape this report answers with.
        return null;
      });
  }
  return null;
}
