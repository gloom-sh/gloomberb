import { createConcurrencyLimiter } from "../../../utils/concurrency";

/**
 * The board's contract histories (use-front-returns) and contract terms
 * (use-board-terms) share one limit of twelve reads at a time, across both and
 * every board open: seventy-odd rows load in about a second without the two
 * crowding out each other or the quotes.
 */
const BOARD_READ_LIMIT = 12;

export const boardRead = createConcurrencyLimiter(BOARD_READ_LIMIT);
