import { createConcurrencyLimiter } from "../../../utils/concurrency";

/**
 * The board's contract histories (use-front-returns) and contract terms
 * (use-board-terms) share one limit of twelve reads at a time, across both and
 * every board open: seventy-odd rows load in about a second without the two
 * crowding out each other or the quotes.
 */
const BOARD_READ_LIMIT = 12;

export const boardRead = createConcurrencyLimiter(BOARD_READ_LIMIT);

/**
 * Reads that reach a source sending reads asked together as batch requests
 * skip that limit: asked all at once, the API client sends a board's rows
 * sixteen a request. This bound only keeps a runaway caller in check.
 */
const BOARD_BATCHED_READ_LIMIT = 200;

const boardBatchedRead = createConcurrencyLimiter(BOARD_BATCHED_READ_LIMIT);

/** The gate for the board's reads: twelve at a time, unless they go out in batch requests. */
export function boardReadGate(batched: boolean): typeof boardRead {
  return batched ? boardBatchedRead : boardRead;
}
