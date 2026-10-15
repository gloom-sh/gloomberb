import { apiClient } from "../../../api-client";
import type { DoePricesPayload } from "../../../api-client/doe";
import { createPluginCache } from "../../../data/plugin-cache";
import type { SeriesDefinition } from "../../../series/types";
import { cachedSeriesWarning } from "../shared/series-warning";
import { loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

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

export const doePriceCache = createPluginCache<DoePricesPayload>({
  kind: "doe-retail-prices", source: "gloom-cloud", schemaVersion: 1,
  // Weekly data: a quarter hour is soon enough to catch a Monday release.
  policy: { staleMs: 15 * 60_000, expireMs: 14 * 24 * 60 * 60_000 },
});

const isDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** A payload that breaks the contract is refused whole rather than charted with holes in it. */
function validatePrices(payload: DoePricesPayload): DoePricesPayload {
  if (!payload || payload.source !== "EIA" || !Number.isFinite(Date.parse(payload.generatedAt))
    || !["available", "partial", "unavailable"].includes(payload.status)
    || !Array.isArray(payload.gaps) || !payload.gaps.every((gap) => typeof gap === "string")
    || !Array.isArray(payload.series) || !payload.series.every((series) => typeof series?.id === "string"
      && typeof series.key === "string" && series.unit === "usd-per-gallon" && Array.isArray(series.points)
      && series.points.every((point) => Array.isArray(point) && isDate(point[0])
        && typeof point[1] === "number" && Number.isFinite(point[1])))) {
    throw new Error("The server returned invalid EIA retail prices");
  }
  return payload;
}

/** A server without the route (404), or without its tables yet (503), has no prices to give. */
async function fetchDoePrices(): Promise<DoePricesPayload> {
  try {
    return validatePrices(await apiClient.getCloudDoePrices());
  } catch (error) {
    throw unavailableOnServer(error, "EIA retail prices are not available yet.", [404, 503]);
  }
}

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
    const resource = await loadCloudResource(doePriceCache, "prices", () => fetchDoePrices(), { validate: validatePrices });
    const row = resource.payload.series.find((entry) => entry.id === series.id);
    if (!row?.points.length) throw new Error(`${series.name} is not available yet.`);
    const warning = cachedSeriesWarning(resource);
    return {
      points: row.points.map(([date, value]) => ({ date, value })),
      ...(warning ? { warning } : {}),
      // Cited as the EIA series it is, not as the route that served it.
      attribution: { source: `EIA series ${series.key}`, publisher: "EIA" },
    };
  },
}));
