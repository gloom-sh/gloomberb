import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { DoePricesPayload } from "../../../api-client/doe";
import { ApiRequestError } from "../../../api-client/errors";
import { DOE_PRICE_SERIES, doePriceCache } from "./prices";

const PAYLOAD: DoePricesPayload = {
  source: "EIA",
  generatedAt: "2026-10-13T09:00:00.000Z",
  status: "partial",
  gaps: ["No history yet for US No. 2 diesel retail price."],
  series: [
    {
      id: "gasoline-price", key: "EMM_EPMR_PTE_NUS_DPG", label: "US regular gasoline retail price", unit: "usd-per-gallon",
      points: [["2026-09-28", 4.465], ["2026-10-05", 4.354]],
    },
    { id: "diesel-price", key: "EMD_EPD2D_PTE_NUS_DPG", label: "US No. 2 diesel retail price", unit: "usd-per-gallon", points: [] },
  ],
};

const load = (id: string) => {
  const series = DOE_PRICE_SERIES.find((entry) => entry.id === id)!;
  if (!("load" in series) || !series.load) throw new Error(`${id} does not load`);
  return series.load({});
};

describe("EIA retail prices from Gloom Cloud", () => {
  afterEach(() => doePriceCache.reset());

  test("each series charts its own Mondays in dollars per gallon and cites the EIA series; an empty one is not available", async () => {
    const served = spyOn(apiClient, "getCloudDoePrices").mockResolvedValue(PAYLOAD);
    try {
      expect(await load("doe:gasoline-price")).toEqual({
        points: [{ date: "2026-09-28", value: 4.465 }, { date: "2026-10-05", value: 4.354 }],
        attribution: { source: "EIA series EMM_EPMR_PTE_NUS_DPG", publisher: "EIA" },
      });
      await expect(load("doe:diesel-price")).rejects.toThrow("US No. 2 diesel retail price is not available yet.");
      // Both series share one request.
      expect(served).toHaveBeenCalledTimes(1);
    } finally {
      served.mockRestore();
    }
  });

  test("a server without the route says the prices are not available yet", async () => {
    const served = spyOn(apiClient, "getCloudDoePrices").mockRejectedValue(new ApiRequestError("Not found", 404));
    try {
      await expect(load("doe:gasoline-price")).rejects.toThrow("EIA retail prices are not available yet.");
    } finally {
      served.mockRestore();
    }
  });
});
