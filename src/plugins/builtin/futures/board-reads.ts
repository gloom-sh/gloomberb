import { createConcurrencyLimiter } from "../../../utils/concurrency";

/**
 * The board's contract histories (use-front-returns) and contract terms
 * (use-board-terms), asked together: the API client sends the reads asked in
 * one moment as batch requests of sixteen, so seventy-two rows load in five
 * requests for terms and five for histories. A service without those batch
 * routes is asked a few reads at a time by the client; this cap only bounds
 * the reads in flight.
 */
const BOARD_READ_LIMIT = 200;

export const boardRead = createConcurrencyLimiter(BOARD_READ_LIMIT);
