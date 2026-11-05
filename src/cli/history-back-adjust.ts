import type { PricePoint } from "../types/financials";
import { historyRolls, type HistoryRoll, type HistoryRow } from "./history-rows";

/**
 * How `history <root>=F --back-adjust` closes the gap at each roll: by the
 * points between the two contracts (difference, the default), which keeps
 * moves in points, or by their ratio, which keeps them in percent.
 */
export type BackAdjustMethod = "difference" | "ratio";

/** A roll as the back-adjusted series stitched it: the two contracts' closes on the day it used, and the gap closed. */
export interface StitchedRoll extends HistoryRoll {
  /** The day both contracts' closes are read on: the roll's own bar, or the one before it when the outgoing contract has none. */
  on: string;
  fromClose: number;
  toClose: number;
  /** What every price before the roll moved by: points added (difference), or the factor it was multiplied by (ratio). */
  adjustment: number;
}

/** A contract's daily closes by date, `YYYY-MM-DD`. */
export type ContractCloses = ReadonlyMap<string, number>;

/** The daily closes of a contract's bars, by date. */
export function contractCloses(points: readonly PricePoint[]): ContractCloses {
  const closes = new Map<string, number>();
  for (const point of points) {
    const time = point.date instanceof Date ? point.date.getTime() : new Date(point.date as string | number).getTime();
    if (Number.isFinite(time) && Number.isFinite(point.close)) closes.set(new Date(time).toISOString().slice(0, 10), point.close);
  }
  return closes;
}

const round = (value: number) => Math.round(value * 1e8) / 1e8;

/**
 * A continuous future's bars stitched into one series at the rolls they
 * name (historyRolls): at each roll the gap between the incoming and the
 * outgoing contract on the same day is closed, every price before it moved
 * by that gap (or scaled by it), the newest contract's prices left as they
 * traded. The gap is read on the roll's own bar from the outgoing contract's
 * close that day (`closes(from)`); where it has none, on the bar before from
 * the incoming contract's close. Volumes are left alone. Throws naming a roll
 * neither contract's bars can price.
 */
export function backAdjustHistory<Row extends Pick<HistoryRow, "date" | "open" | "high" | "low" | "close" | "contract" | "roll">>(
  rows: readonly Row[],
  method: BackAdjustMethod,
  closes: (contract: string) => ContractCloses | undefined,
): { rows: Row[]; rolls: StitchedRoll[] } {
  const rolls = historyRolls(rows);
  const day = (row: Row) => row.date.slice(0, 10);
  const stitched = rolls.map((roll): StitchedRoll => {
    const at = rows.findIndex((row) => row.date === roll.date);
    const own = rows[at]!;
    const before = rows[at - 1];
    const outgoing = closes(roll.from)?.get(day(own));
    if (own.close != null && outgoing != null) {
      return { ...roll, on: day(own), fromClose: outgoing, toClose: own.close, adjustment: gap(method, outgoing, own.close) };
    }
    const incoming = before ? closes(roll.to)?.get(day(before)) : undefined;
    if (before?.close != null && incoming != null) {
      return { ...roll, on: day(before), fromClose: before.close, toClose: incoming, adjustment: gap(method, before.close, incoming) };
    }
    throw new Error(`No close of ${roll.from} or ${roll.to} on ${day(own)} or the bar before to stitch that roll.`);
  });
  // Newest first: each roll moves every price before it, on top of the rolls after it.
  let shift = method === "ratio" ? 1 : 0;
  let next = stitched.length - 1;
  const adjusted = new Array<Row>(rows.length);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    while (next >= 0 && row.date < stitched[next]!.date) {
      shift = method === "ratio" ? shift * stitched[next]!.adjustment : shift + stitched[next]!.adjustment;
      next--;
    }
    const move = (price: number | null) => price == null ? null : round(method === "ratio" ? price * shift : price + shift);
    adjusted[index] = (method === "ratio" ? shift === 1 : shift === 0) ? row
      : { ...row, open: move(row.open), high: move(row.high), low: move(row.low), close: move(row.close) };
  }
  return { rows: adjusted, rolls: stitched };
}

function gap(method: BackAdjustMethod, outgoing: number, incoming: number): number {
  // A ratio stays whole: rounded, it would move every price it scales.
  return method === "ratio" ? incoming / outgoing : round(incoming - outgoing);
}

/**
 * "CLX26 to CLZ26 on 2026-10-16 (+0.62)": each roll stitched, newest last,
 * as the warning lists them, and from when the bars name their contracts
 * when the first ones do not (`namedFrom`): a roll before that is not known,
 * so it is left as traded.
 */
export function stitchedRollsNote(symbol: string, method: BackAdjustMethod, rolls: readonly StitchedRoll[], namedFrom: string | null = null): string {
  const unnamed = namedFrom ? ` Bars before ${namedFrom.slice(0, 10)} name no contract, so a roll before then is left as traded.` : "";
  if (rolls.length === 0) return `${symbol} did not roll in the bars shown: nothing to back-adjust.${unnamed}`;
  const listed = rolls.map((roll) => {
    const amount = method === "ratio" ? `x${roll.adjustment.toFixed(6)}` : `${roll.adjustment >= 0 ? "+" : ""}${roll.adjustment}`;
    return `${roll.from} to ${roll.to} on ${roll.date.slice(0, 10)} (${amount}${roll.on !== roll.date.slice(0, 10) ? `, read on ${roll.on}` : ""})`;
  });
  return `${symbol} back-adjusted by ${method === "ratio" ? "ratio" : "difference"} at ${rolls.length === 1 ? "its roll" : `${rolls.length} rolls`}: `
    + `${listed.join("; ")}. Every price before a roll is ${method === "ratio" ? "scaled by" : "moved by"} the gap between the two contracts that day; `
    + `the newest contract's prices are as traded.${unnamed}`;
}
