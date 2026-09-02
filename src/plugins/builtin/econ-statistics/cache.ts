import { createSeriesCache } from "../shared/series-cache";

/** Most of these print monthly, so a six-hour window is plenty. */
export const statsCache = createSeriesCache("econ-statistics-series", 6 * 60 * 60 * 1000);
