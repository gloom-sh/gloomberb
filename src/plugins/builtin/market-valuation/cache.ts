import { createSeriesCache } from "../shared/series-cache";

export const valuationCache = createSeriesCache("market-valuation-series", 6 * 60 * 60 * 1000);
