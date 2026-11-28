import { apiClient } from "../../../api-client";
import type { DoePricesPayload } from "../../../api-client/doe";
import type { SeriesDefinition } from "../../../series/types";
import { isCalendarDay, isFiniteNumber, isStringArray } from "../../../utils/guards";
import { cachedSeriesNote } from "../shared/series-warning";
import { createCloudEndpoint } from "../shared/cloud-resource";

/**
 * EIA weekly retail prices the petroleum board does not carry, served by Gloom
 * Cloud from the EIA's history workbooks. `key` is the EIA series id a report
 * of the series cites.
 */
const PRICE_SERIES = [
  {
    id: "gasoline-price",
    name: "US regular gasoline retail price",
    key: "EMM_EPMR_PTE_NUS_DPG",
    url: "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=EMM_EPMR_PTE_NUS_DPG&f=W",
    tags: ["gasoline", "retail", "pump price"],
  },
  {
    id: "diesel-price",
    name: "US No. 2 diesel retail price",
    key: "EMD_EPD2D_PTE_NUS_DPG",
    url: "https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=EMD_EPD2D_PTE_NUS_DPG&f=W",
    tags: ["diesel", "retail", "pump price"],
  },
] as const;

/** A payload that breaks the contract is refused whole rather than charted with holes in it. */
function validatePrices(payload: DoePricesPayload): DoePricesPayload {
  if (!payload || payload.source !== "EIA" || !Number.isFinite(Date.parse(payload.generatedAt))
    || !["available", "partial", "unavailable"].includes(payload.status) || !isStringArray(payload.gaps)
    || !Array.isArray(payload.series) || !payload.series.every((series) => typeof series?.id === "string"
      && typeof series.key === "string" && series.unit === "usd-per-gallon" && Array.isArray(series.points)
      && series.points.every((point) => Array.isArray(point) && isCalendarDay(point[0]) && isFiniteNumber(point[1])))) {
    throw new Error("The server returned invalid EIA retail prices");
  }
  return payload;
}

const doePriceEndpoint = createCloudEndpoint<void, DoePricesPayload, typeof apiClient>({
  kind: "doe-retail-prices", schemaVersion: 1,
  // Weekly data: a quarter hour is soon enough to catch a Monday release.
  policy: { staleMs: 15 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
  key: "prices", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudDoePrices(), validate: validatePrices,
  unavailableMessage: "EIA retail prices are not available yet.", unavailableStatuses: [404, 503],
});
export const doePriceCache = doePriceEndpoint.cache;

export const DOE_PRICE_SERIES: readonly SeriesDefinition[] = PRICE_SERIES.map((series) => ({
  id: `doe:${series.id}`,
  name: series.name,
  unit: "USD/gallon",
  frequency: "weekly",
  group: "Energy",
  publisher: "EIA",
  url: series.url,
  tags: ["oil", "petroleum", "EIA", "weekly", ...series.tags],
  description: "EIA weekly US retail price. Not gasoline stocks, and not the AAA daily average.",
  load: async () => {
    const resource = await doePriceEndpoint.load();
    const row = resource.payload.series.find((entry) => entry.id === series.id);
    if (!row?.points.length) throw new Error(`${series.name} is not available yet.`);
    return {
      points: row.points.map(([date, value]) => ({ date, value })),
      ...cachedSeriesNote(resource),
      // Cited as the EIA series it is, not as the route that served it.
      attribution: { source: `EIA series ${series.key}`, publisher: "EIA" },
    };
  },
}));
