import { apiClient } from "../../../api-client";
import { sourceDidNotAnswer } from "../../../api-client/errors";
import type { JodiBoardPayload } from "../../../api-client/commodity-balances";
import { unavailableOnServer } from "../shared/cloud-resource";
import type { BalanceCommodity, Board } from "./model";

/** What the pane says while the server has no balances to serve: before its first read of JODI's files. */
export const JODI_NOT_AVAILABLE = "Oil and gas balances are not available yet.";

export interface Balances {
  oil: Board;
  gas: Board | null;
  /** The server could not read JODI for days: these are its last copies. */
  stale: boolean;
  /** What is missing or out of date, in words. */
  gaps: string[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const FIGURES = ["production", "demand", "imports", "exports", "stocks"] as const;
const figure = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));

function validBoard(board: Board | null | undefined, commodity: BalanceCommodity): board is Board {
  return !!board && board.commodity === commodity && MONTH.test(board.month) && Array.isArray(board.rows)
    && board.rows.every((row) => typeof row.country === "string" && typeof row.unit === "string"
      && (row.month === null || MONTH.test(row.month)) && FIGURES.every((field) => figure(row[field])));
}

/** A board that breaks the contract is refused whole rather than drawn with holes in it. */
function readBoard(payload: JodiBoardPayload): Balances {
  if (!payload || payload.source !== "JODI" || !Array.isArray(payload.gaps)
    || !payload.gaps.every((gap) => typeof gap === "string")
    || (payload.gas != null && !validBoard(payload.gas, "gas"))) {
    throw new Error("The server returned an invalid oil and gas balance board");
  }
  // The server's source did not answer this time, which may pass; a board with no oil has none yet.
  if (payload.status === "unavailable") throw sourceDidNotAnswer(JODI_NOT_AVAILABLE);
  if (payload.oil == null) throw new Error(JODI_NOT_AVAILABLE);
  if (!validBoard(payload.oil, "oil")) throw new Error("The server returned an invalid oil and gas balance board");
  return { oil: payload.oil, gas: payload.gas ?? null, stale: payload.stale === true, gaps: payload.gaps };
}

/**
 * JODI's latest crude and natural gas balances for the largest countries, each
 * country at its own latest reported month. Gloom Cloud reads JODI's files; a
 * route the server does not serve yet (404) or cannot read (503) is the
 * not-available message.
 */
export async function fetchBalances(
  signal?: AbortSignal,
  client: Pick<typeof apiClient, "getCloudJodiBoard"> = apiClient,
): Promise<Balances> {
  let payload: JodiBoardPayload;
  try {
    payload = await client.getCloudJodiBoard(signal);
  } catch (error) {
    throw unavailableOnServer(error, JODI_NOT_AVAILABLE, [404, 503]);
  }
  return readBoard(payload);
}
