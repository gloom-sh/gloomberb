import { expect, test } from "bun:test";
import type { DatedReturn } from "./metrics";
import { episodeCloses, episodeEvidence, episodeIssues, fetchRiskEpisodeHistory, replayEpisodes, RISK_EPISODES, type EpisodeReader } from "./risk-episodes";

const covid = RISK_EPISODES.find((episode) => episode.id === "covid-2020")!;

function returns(length = 140, scale = 1): DatedReturn[] {
  const start = Date.parse("2025-01-01");
  return Array.from({ length }, (_, index) => ({
    startDateKey: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    dateKey: new Date(start + (index + 1) * 86_400_000).toISOString().slice(0, 10),
    value: (scale * Math.sin(index)) / 100,
  }));
}

test("an episode reads the last close on or before each date, and none for a series that starts after it", () => {
  // 19 Feb 2020 is a Wednesday with a close; 23 Mar has none here, so the 20 Mar close stands in.
  const closes = episodeCloses([
    { date: "2020-02-18", close: 99 },
    { date: "2020-02-19", close: 100 },
    { date: "2020-03-20", close: 70 },
    { date: "2022-01-03", close: 200 },
  ]);
  expect(closes["covid-2020"]).toEqual({ start: { date: "2020-02-19", close: 100 }, end: { date: "2020-03-20", close: 70 } });
  // The 2022 window has a start but no end close within a week of 12 Oct.
  expect(closes["rates-2022"]).toBeUndefined();
  expect(episodeCloses([{ date: "2020-09-30", close: 10 }, { date: "2025-04-08", close: 20 }])["covid-2020"]).toBeUndefined();
});

test("a replay weights each holding's own move, converts a foreign one at the same dates' FX, and proxies one without closes by its beta", async () => {
  const spy = returns();
  const window = (start: number, end: number) => ({ [covid.id]: { start: { date: covid.start, close: start }, end: { date: covid.end, close: end } } });
  const reader: EpisodeReader = {
    async instrument(instrument) {
      if (instrument.symbol === "SPY") return window(100, 66);
      if (instrument.symbol === "AAA") return window(50, 40);
      if (instrument.symbol === "LON") return window(1000, 900);
      return {};
    },
    // USD per pound: 1.30 to 1.17, a pound 10% weaker.
    async currency() {
      return window(1.3, 1.17);
    },
  };
  const history = await fetchRiskEpisodeHistory(
    [
      { instrument: { symbol: "AAA", exchange: "NYSE" }, currency: null },
      { instrument: { symbol: "LON", exchange: "LSE" }, currency: "GBp" },
      { instrument: { symbol: "NEW", exchange: "NYSE" }, currency: null },
    ],
    "USD",
    reader,
  );
  const [replay] = replayEpisodes(
    history,
    [
      { id: "NYSE:AAA", symbol: "AAA", weight: 0.5, value: 500, convertedFrom: null, returns: spy },
      { id: "LSE:LON", symbol: "LON", weight: 0.3, value: 300, convertedFrom: "GBp", returns: spy },
      // Twice SPY's daily moves: a beta of 2.
      { id: "NYSE:NEW", symbol: "NEW", weight: 0.2, value: 200, convertedFrom: null, returns: returns(140, 2) },
    ],
    { spyReturns: spy, accountCurrency: "USD", bookValue: 1250 },
  );
  expect(replay!.episode.id).toBe(covid.id);
  expect(replay!.spy).toBeCloseTo(-0.34, 12);
  // 0.5 * -20% + 0.3 * (0.9 * 0.9 - 1) + 0.2 * 2 * -34%
  expect(replay!.value).toBeCloseTo(0.5 * -0.2 + 0.3 * -0.19 + 0.2 * 2 * -0.34, 10);
  expect(replay!.proxied).toEqual([{ id: "NYSE:NEW", symbol: "NEW", beta: expect.closeTo(2, 10), assumed: false, weight: 0.2, bookShare: 0.16, failed: false }]);
  // The proxy's share is of the basket the value is a percent of.
  expect(episodeEvidence(replay!, "USD")).toBe("% of basket; NEW by beta proxy, 20% of basket; 19 Feb to 23 Mar 2020 closes; SPY -34.0%; price return");
});

test("closes that fail to load are warnings: a holding's is replayed by proxy, SPY's leaves every episode without a value", async () => {
  const members = [{ id: "NYSE:AAA", symbol: "AAA", weight: 1, value: 100, convertedFrom: null, returns: returns() }];
  const options = { spyReturns: returns(), accountCurrency: "USD", bookValue: 100 };
  const window = { [covid.id]: { start: { date: covid.start, close: 100 }, end: { date: covid.end, close: 66 } } };
  const failing = (symbol: string): EpisodeReader => ({
    async instrument(instrument) {
      if (instrument.symbol === symbol) throw new Error("UPSTREAM_RATE_LIMIT");
      return window;
    },
    async currency() {
      return {};
    },
  });
  const target = [{ instrument: { symbol: "AAA", exchange: "NYSE" }, currency: null }];
  const holding = replayEpisodes(await fetchRiskEpisodeHistory(target, "USD", failing("AAA")), members, options);
  expect(holding[0]!.proxied[0]).toMatchObject({ symbol: "AAA", failed: true });
  expect(episodeIssues(holding)).toEqual({
    notes: [],
    warnings: [
      "AAA (100% of the basket, 100% of the book): daily closes for Covid crash 2020 did not load; that replay moves it by its beta of 1.00 to SPY.",
      "Rate shock 2022, Carry unwind 2024, Tariff drop 2025: SPY has no daily closes over the window.",
    ],
  });
  const spy = replayEpisodes(await fetchRiskEpisodeHistory(target, "USD", failing("SPY")), members, options);
  expect(spy.every((replay) => replay.value == null)).toBe(true);
  expect(episodeIssues(spy).warnings).toEqual(["Historical episodes: SPY daily closes did not load: UPSTREAM_RATE_LIMIT."]);
});
