import { createSeriesCache } from "../shared/series-cache";

/**
 * Most of these print monthly, so a six-hour window is plenty. v2: daily and
 * weekly series now load their full history, so entries cut to the old
 * observation limits must not be served after an upgrade.
 */
export const statsCache = createSeriesCache("econ-statistics-series-v2", 6 * 60 * 60 * 1000);
