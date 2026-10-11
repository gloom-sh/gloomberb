import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { SeriesLoadOutput } from "../../../series/types";
import { PERP_SERIES } from "./series";
import { longShort, longShortPoint, perpBoard, perpHistory, perpRow } from "./test-fixture";

const longAccounts = PERP_SERIES.find((series) => series.id === "perps:long-accounts")!;
const load = (ticker: string) => longAccounts.load!({ ticker }) as Promise<SeriesLoadOutput>;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

test("long account share reads the largest live contract whose venue publishes a ratio, and a preview fails with the pane's Pro message", async () => {
  // The coin's largest contract publishes no ratio, the next is delisted: the third is the one to read.
  const rows = [perpRow({ marketId: "venue-a:BTC", longShortRatio: null, longShortRatioReason: "unsupported" }),
    perpRow({ marketId: "venue-b:BTC", delisted: true, longShortRatio: longShort() }), perpRow({ marketId: "venue-c:BTC", longShortRatio: longShort() })];
  const asked: string[] = [];
  spies.push(spyOn(apiClient, "getCloudPerpsCompare").mockImplementation(async () => perpBoard({ rows })));
  spies.push(spyOn(apiClient, "getCloudPerpsHistory").mockImplementation(async (query) => {
    asked.push(query.marketId);
    return perpHistory({ marketId: query.marketId, longShortRatio: [longShortPoint("2026-10-09T10:00:00.000Z", 0.6), longShortPoint("2026-10-09T11:00:00.000Z", 0.625)] });
  }));
  expect(await load("BTC-USD")).toEqual([{ date: "2026-10-09T10:00:00.000Z", value: 60 }, { date: "2026-10-09T11:00:00.000Z", value: 62.5 }]);
  expect(asked).toEqual(["venue-c:BTC"]);

  for (const spy of spies.splice(0)) spy.mockRestore();
  spies.push(spyOn(apiClient, "getCloudPerpsCompare").mockImplementation(async () => perpBoard({ rows, access: "preview", locked: 3 })));
  await expect(load("BTC-USD")).rejects.toThrow("Full history requires Gloom Pro.");
});
