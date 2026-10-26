import {
  apiClient,
  type ScannerFlowSession,
  type ScannerFlowSessionStrike,
} from "../../../api-client";
import { signalWithTimeout } from "../../../utils/async-deadline";
import { formatFlowPremium } from "./flow-model";

/**
 * The session's recorded prints summed by the server under the pane's
 * filters: the net-premium tide through the day and, for one name, its
 * premium by expiry and strike. A print at the ask counts as bought and one at
 * the bid as sold; mid prints count as neither (docs/usage.md, Options flow).
 */
export type FlowSessionLoader = (search: string, signal?: AbortSignal) => Promise<ScannerFlowSession>;

export const loadFlowSession: FlowSessionLoader = (search, signal) =>
  apiClient.getScannerFlowSession(search, signalWithTimeout(signal, 20_000));

/** A summary is refetched this often while the tape is live; it is final once the session closes. */
export const FLOW_SESSION_LIVE_REFRESH_MS = 60_000;

/** One bucket of the tide: what it added, and the running totals through it. */
export interface FlowTideRow {
  at: number;
  /** Call premium bought at the ask less call premium sold at the bid, through this bucket. */
  netCalls: number;
  netPuts: number;
  /** Net calls less net puts through this bucket: the tide. */
  net: number;
  /** What this bucket added to the tide. */
  change: number;
  callAsk: number;
  callBid: number;
  putAsk: number;
  putBid: number;
}

/** The tide bucket by bucket, oldest first, each row with the running totals through it. */
export function flowTideRows(session: ScannerFlowSession | null | undefined): FlowTideRow[] {
  let netCalls = 0;
  let netPuts = 0;
  return [...(session?.buckets ?? [])].sort((left, right) => left.at - right.at).map((bucket) => {
    const calls = bucket.callAsk - bucket.callBid;
    const puts = bucket.putAsk - bucket.putBid;
    netCalls += calls;
    netPuts += puts;
    return {
      at: bucket.at,
      netCalls,
      netPuts,
      net: netCalls - netPuts,
      change: calls - puts,
      callAsk: bucket.callAsk,
      callBid: bucket.callBid,
      putAsk: bucket.putAsk,
      putBid: bucket.putBid,
    };
  });
}

/**
 * The running totals at every bucket from the first to the last, so a line
 * holds flat through a quiet stretch instead of sloping across it.
 */
export function flowTidePoints(rows: readonly FlowTideRow[], bucketMs: number): Array<Pick<FlowTideRow, "at" | "netCalls" | "netPuts" | "net">> {
  const points: Array<Pick<FlowTideRow, "at" | "netCalls" | "netPuts" | "net">> = [];
  let previous: FlowTideRow | null = null;
  for (const row of rows) {
    if (previous && bucketMs > 0) {
      for (let at = previous.at + bucketMs; at < row.at; at += bucketMs) {
        points.push({ at, netCalls: previous.netCalls, netPuts: previous.netPuts, net: previous.net });
      }
    }
    points.push({ at: row.at, netCalls: row.netCalls, netPuts: row.netPuts, net: row.net });
    previous = row;
  }
  return points;
}

export interface FlowStrikeRow extends ScannerFlowSessionStrike {
  id: string;
  /** Net call premium less net put premium at this strike, by the same side rule as the tide. */
  net: number;
}

export function flowStrikeRows(session: ScannerFlowSession | null | undefined): FlowStrikeRow[] {
  return (session?.strikes ?? []).map((strike) => ({
    ...strike,
    id: `${strike.expiry}:${strike.strike}`,
    net: strike.callAsk - strike.callBid - (strike.putAsk - strike.putBid),
  }));
}

export type FlowStrikeSort = "expiry" | "strike" | "callPremium" | "callAsk" | "callBid" | "putPremium" | "putAsk" | "putBid" | "net";

/** The breakdown in a column's order; ties fall back to expiry, then strike. */
export function sortFlowStrikes(
  rows: readonly FlowStrikeRow[],
  column: FlowStrikeSort | null,
  direction: "asc" | "desc",
): FlowStrikeRow[] {
  if (!column) return [...rows];
  const sign = direction === "asc" ? 1 : -1;
  const byContract = (left: FlowStrikeRow, right: FlowStrikeRow) =>
    left.expiry.localeCompare(right.expiry) || left.strike - right.strike;
  return [...rows].sort((left, right) => {
    const primary = column === "expiry" ? left.expiry.localeCompare(right.expiry)
      : column === "strike" ? left.strike - right.strike
        : left[column] - right[column];
    return primary * sign || byContract(left, right);
  });
}

/** A premium that can go either way, with its sign: `+$1.2M`, `-$350K`. */
export function formatSignedFlowPremium(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.5) return "$0";
  return `${value > 0 ? "+" : "-"}${formatFlowPremium(Math.abs(value))}`;
}

/** An expiry as the table reads it: `10/30`, with the year when it is not this one. */
export function formatStrikeExpiry(expiry: string, now = Date.now()): string {
  const [year, month, day] = expiry.split("-");
  if (!year || !month || !day) return expiry;
  return year === String(new Date(now).getFullYear()) ? `${month}/${day}` : `${month}/${day}/${year.slice(2)}`;
}

/** A bucket's start as the local wall clock, `10:35`. */
export function formatTideTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The session's date as the chart's legend names it: `Mon 26 Oct`. */
export function formatFlowSessionDate(session: string | null | undefined): string | null {
  if (!session) return null;
  const date = new Date(`${session}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .replace(/^(\w+), (\w+) (\d+)$/, "$1 $3 $2");
}
