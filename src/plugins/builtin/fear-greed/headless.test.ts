import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { collectSavedCopies, savedCopyShownAt } from "../../../data/saved-copies";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../../../utils/network-failure";
import { loadFearGreed, resetFearGreedPersistence } from "./cache";
import { createFearGreedHeadless } from "./headless";
import { fetchFearGreedData, type FearGreedData } from "./data";

afterEach(() => {
  setSystemTime();
  resetFearGreedPersistence();
});

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

const data: FearGreedData = {
  overall: {
    score: 63,
    rating: "greed",
    updatedAt: new Date("2026-09-04T12:00:00Z"),
    previousClose: 58,
    previousWeek: 41,
    previousMonth: 35,
    previousYear: 52,
    history: [],
  },
  indicators: [{
    definition: {
      id: "market-volatility",
      title: "Market Volatility",
      subtitle: "VIX and its 50-day moving average",
      primaryKey: "market_volatility_vix",
      primaryLabel: "VIX",
      secondaryKey: "market_volatility_vix_50",
      secondaryLabel: "50-day moving average",
      valueFormat: "number",
    },
    score: 72,
    rating: "greed",
    updatedAt: new Date("2026-09-04T12:00:00Z"),
    points: [],
    secondaryPoints: [],
    latestValue: 14.25,
    latestSecondaryValue: 17.5,
  }],
};

describe("fear and greed headless model", () => {
  test("maps the loaded index and indicators into shared sections", async () => {
    const headless = createFearGreedHeadless({
      load: async () => ({ data, fetchedAt: 123, stale: false }),
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);

    expect(result.sections[0]?.title).toBe("Fear & Greed Index");
    expect(result.sections[0]?.entries?.[0]).toMatchObject({ label: "Score", value: 63 });
    expect(result.sections[1]?.rows?.[0]).toMatchObject({
      id: "market-volatility", latestValue: 14.25, secondaryValue: 17.5,
    });
  });

  test("offline, the index is the copy it saved, dated, with no error; any other failure stays the error beside it", async () => {
    // No connection reads as every other pane says it, not in the fetch's own words.
    const unreachable = await fetchFearGreedData({
      fetcher: async () => { throw new Error("Unable to connect. Is the computer able to access the url?"); },
    }).catch((error: unknown) => error);
    expect((unreachable as Error).message).toBe(DATA_SERVICE_UNREACHABLE_MESSAGE);

    let failure: unknown = null;
    const headless = createFearGreedHeadless({ load: () => loadFearGreed(false, async () => {
      if (failure) throw failure;
      return data;
    }) });
    const read = () => collectSavedCopies(async () => {
      const result = await headless.load(args, {} as HeadlessPaneContext);
      return { savedAt: savedCopyShownAt(result), errors: result.errors ?? [] };
    });
    const saved = Date.parse("2026-11-11T15:33:00Z");
    setSystemTime(new Date(saved));
    expect(await read()).toEqual({ savedAt: null, errors: [] });
    // Past the five minutes a reading is kept fresh, so the next read asks again.
    setSystemTime(new Date(saved + 10 * 60_000));
    failure = unreachable;
    expect(await read()).toEqual({ savedAt: saved, errors: [] });
    failure = new Error("CNN Fear & Greed answered with an unreadable page");
    expect(await read()).toEqual({ savedAt: null, errors: ["CNN Fear & Greed answered with an unreadable page"] });
  });
});
