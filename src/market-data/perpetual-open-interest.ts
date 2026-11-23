import type { PerpBoardRow, PerpOpenInterestSource } from "../api-client/perps";
import { isRecord } from "../utils/guards";

/** A perpetual's open interest as PERP, the quote cards and `gloom quote` read it. */
export type PerpOpenInterest = Partial<Pick<PerpBoardRow, "openInterestBase" | "openInterestUsd" | "openInterestSource">>;

const readableTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

/**
 * Where and when a market's open interest was read, as the server states it. Never the market's own source: a venue
 * serves open interest from another endpoint (Binance's openInterest), and a streamed mark sits beside the open
 * interest the last poll read. Null without open interest, from a server that does not say, and for a market stored
 * before it was recorded.
 */
export function openInterestSourceOf(row: PerpOpenInterest): PerpOpenInterestSource | null {
  const source: unknown = row.openInterestSource;
  if (row.openInterestBase == null && row.openInterestUsd == null || !isRecord(source)) return null;
  return typeof source.url === "string" && readableTime(source.observedAt) && (source.asOf == null || readableTime(source.asOf))
    ? source as unknown as PerpOpenInterestSource : null;
}

/**
 * When a row's figures were read: its own observation, or its open interest's read when that is older (a streamed
 * mark beside the open interest the last poll read), so a row is never dated newer than a figure it shows.
 */
export function rowReadAt(row: PerpOpenInterest & Pick<PerpBoardRow, "observedAt">): string {
  const interest = openInterestSourceOf(row)?.observedAt;
  return interest && Date.parse(interest) < Date.parse(row.observedAt) ? interest : row.observedAt;
}
