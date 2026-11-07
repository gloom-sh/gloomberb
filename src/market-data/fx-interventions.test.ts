import { expect, test } from "bun:test";
import type { FxInterventionDay, FxInterventionRun, FxInterventionsPayload } from "../api-client/fx-interventions";
import { createTestResolvedSeries, createTestSeriesPoint as point } from "../test-support/time-series";
import type { ChartSpec } from "../time-series/types";
import { chartInterventions, interventionChartEvents } from "../plugins/builtin/chart-composer/intervention-events";
import {
  createFxInterventionsLoader,
  fxInterventionLatestNote,
  fxInterventionMarkers,
  fxInterventionPair,
  fxInterventionSharedCaptions,
  fxInterventionWindowNote,
  readFxInterventions,
} from "./fx-interventions";

type Side = Pick<FxInterventionDay, "sold" | "bought" | "pair">;
const USD_SOLD: Side = { sold: "USD", bought: "JPY", pair: "the US dollar (sold) the Japanese yen (bought)" };
const USD_BOUGHT: Side = { sold: "JPY", bought: "USD", pair: "the US dollar (bought) the Japanese yen (sold)" };
const EUR_BOUGHT: Side = { sold: "JPY", bought: "EUR", pair: "the Euro (bought) the Japanese yen (sold)" };
const run = (from: string, to: string, days: number, billions: number, side: Side): FxInterventionRun => (
  { from, to, days, amountJpy: Math.round(billions * 1e9), ...side }
);
const month = (from: string, to: string, billions: number, undatedBillions: number, releasedOn: string) => ({
  from, to, amountJpy: Math.round(billions * 1e9), releasedOn,
  daysKnown: (undatedBillions === 0 ? "all" : "none") as "all" | "none", undatedAmountJpy: Math.round(undatedBillions * 1e9),
});

/** The ministry's record as served on 7 Nov 2026, cut to a few interventions: July 2026's total has no days yet. */
function record(): FxInterventionsPayload {
  return {
    authority: "Japan Ministry of Finance",
    status: "available",
    days: [],
    interventions: [
      run("2003-05-08", "2003-05-09", 2, 82.9, EUR_BOUGHT),
      run("2010-09-15", "2010-09-15", 1, 2124.9, USD_BOUGHT),
      run("2011-10-31", "2011-11-04", 5, 9091.7, USD_BOUGHT),
      run("2022-09-22", "2022-09-22", 1, 2838.2, USD_SOLD),
      run("2022-10-21", "2022-10-24", 2, 6349.8, USD_SOLD),
      run("2024-04-29", "2024-05-01", 2, 9788.5, USD_SOLD),
      run("2024-07-11", "2024-07-12", 2, 5534.8, USD_SOLD),
      run("2026-04-30", "2026-05-06", 3, 11734.8, USD_SOLD),
    ],
    dailyThrough: "2026-06-30",
    months: [
      month("2026-04-28", "2026-05-27", 11734.9, 0, "2026-05-29"),
      month("2026-06-29", "2026-07-29", 0, 0, "2026-07-31"),
      month("2026-07-30", "2026-08-26", 15399.3, 15399.3, "2026-08-28"),
      month("2026-09-29", "2026-10-28", 0, 0, "2026-10-30"),
    ],
    quarters: [],
    fetchedAt: "2026-11-07T07:37:53.746Z",
    sourceUrl: "https://www.mof.go.jp/english/policy/international_policy/reference/feio/index.html",
    notes: [],
  };
}

const USDJPY = { base: "USD", quote: "JPY" };

test("fx names the total reported without days with its release day, then the pair's last intervention; JPY/USD reads the same and a cross never shows the total", () => {
  expect(fxInterventionLatestNote(record(), USDJPY)).toBe(
    "Japan's Ministry of Finance reported ¥15,399.3 billion of intervention from 30 Jul to 26 Aug 2026, a monthly total released 28 Aug 2026: its days and pair come with the quarterly release. "
    + "Its last dated intervention in USD/JPY: 30 Apr–6 May 2026, ¥11,734.8 billion of dollars sold for yen on 3 days. Records through 28 Oct 2026.",
  );
  expect(fxInterventionPair("JPYUSD=X")).toEqual({ base: "JPY", quote: "USD" });
  expect(fxInterventionLatestNote(record(), fxInterventionPair("JPYUSD=X")!)).toContain(
    "Its last dated intervention in JPY/USD: 30 Apr–6 May 2026, ¥11,734.8 billion of dollars sold for yen on 3 days.",
  );
  // A total names no pair: EUR/JPY gets its own last intervention only.
  expect(fxInterventionLatestNote(record(), fxInterventionPair("EURJPY=X")!)).toBe(
    "Japan's Ministry of Finance last intervened in EUR/JPY: 8–9 May 2003, ¥82.9 billion of yen sold for euros on 2 days. Records through 28 Oct 2026.",
  );
  expect(fxInterventionLatestNote(record(), { base: "GBP", quote: "JPY" })).toBeNull();
  expect(fxInterventionPair("EURUSD=X")).toBeNull();
  expect(fxInterventionPair("6J=F")).toBeNull();
});

test("history names its bars' interventions in short amounts, the side once when they share it, and only the undated part of a month that runs past the days", () => {
  expect(fxInterventionWindowNote(record(), USDJPY, "2024-04-01", "2024-08-01")).toBe(
    "Japan's Ministry of Finance bought yen in USD/JPY in these bars: 29 Apr–1 May 2024 ¥9.8tn; 11–12 Jul 2024 ¥5.5tn.",
  );
  expect(fxInterventionWindowNote(record(), USDJPY, "2001-01-02", "2026-11-06")).toBe(
    "Japan's Ministry of Finance intervened in USD/JPY in these bars: 31 Oct–4 Nov 2011 ¥9.1tn yen sold; 22 Sep 2022 ¥2.8tn yen bought; "
    + "21–24 Oct 2022 ¥6.3tn yen bought; 29 Apr–1 May 2024 ¥9.8tn yen bought; 11–12 Jul 2024 ¥5.5tn yen bought; 30 Apr–6 May 2026 ¥11.7tn yen bought; "
    + "and 1 earlier from 15 Sep 2010. It also reported ¥15.4tn from 30 Jul to 26 Aug 2026, a monthly total released 28 Aug 2026: its days and pair come with the quarterly release.",
  );
  expect(fxInterventionWindowNote(record(), USDJPY, "2026-10-01", "2026-11-06")).toBeNull();
  // October 2022's release covers 29 Sep to 27 Oct with the days through 30 September: what is undated starts on 1 October.
  const crossing: FxInterventionsPayload = {
    ...record(), interventions: record().interventions.slice(0, 4), dailyThrough: "2022-09-30",
    months: [{ ...month("2022-09-29", "2022-10-27", 6349.9, 6349.9, "2022-10-31"), daysKnown: "partial" }],
  };
  expect(fxInterventionWindowNote(crossing, USDJPY, "2022-10-03", "2022-10-31")).toBe(
    "Japan's Ministry of Finance reported ¥6.3tn from 1 Oct to 27 Oct 2022, a monthly total released 31 Oct 2022: its days and pair come with the quarterly release.",
  );
});

test("a marker is captioned with its amount and side, MoF going first when room is short; the undated total spans its period on USD/JPY only", () => {
  const markers = fxInterventionMarkers(record(), USDJPY);
  expect(markers.slice(-2).map(({ id, date, endDate, captions, undated }) => ({ id, date, endDate, captions, undated }))).toEqual([
    { id: "mof:2026-04-30:USD:JPY", date: "2026-04-30", endDate: undefined, captions: ["MoF ¥11.7tn yen bought", "¥11.7tn yen bought", "¥11.7tn"], undated: false },
    {
      id: "mof:2026-07-30:2026-08-26", date: "2026-07-30", endDate: "2026-08-26", undated: true,
      captions: ["MoF ¥15.4tn 30 Jul–26 Aug, pair not yet published", "¥15.4tn 30 Jul–26 Aug, pair not yet published", "¥15.4tn 30 Jul–26 Aug"],
    },
  ]);
  expect(fxInterventionMarkers(record(), { base: "EUR", quote: "JPY" }).map((marker) => marker.id)).toEqual(["mof:2003-05-08:JPY:EUR"]);
  expect(fxInterventionSharedCaptions(markers.slice(2, 4))).toEqual(["MoF ¥9.2tn ×2 yen bought", "¥9.2tn ×2 yen bought", "¥9.2tn ×2"]);
  expect(fxInterventionSharedCaptions(markers.slice(-2))).toEqual(["MoF ¥27.1tn ×2", "¥27.1tn ×2"]);
});

test("a marker goes on the bar holding its day, a daily bar stamped at 23:00Z counting as the next day; a total spans its first day's bar to its last's", () => {
  const markers = fxInterventionMarkers(record(), USDJPY).slice(-2);
  const at = (date: string) => Date.parse(date);
  // London's midnight in summer: each daily bar is stamped 23:00Z the day before.
  const london = ["2026-04-28", "2026-04-29", "2026-04-30", "2026-07-29", "2026-08-25", "2026-08-26"].map((date) => at(`${date}T23:00:00Z`));
  expect(interventionChartEvents(markers, london).map((event) => [event.time, event.endTime, event.dotted ?? false])).toEqual([
    [at("2026-04-29T23:00:00Z"), undefined, false],
    [at("2026-07-29T23:00:00Z"), at("2026-08-25T23:00:00Z"), true],
  ]);
  // Weekly bars dated by their Monday: the week's.
  const weekly = ["2026-04-27", "2026-07-27", "2026-08-24"].map((date) => at(`${date}T00:00:00Z`));
  expect(interventionChartEvents(markers, weekly).map((event) => [event.time, event.endTime])).toEqual([
    [at("2026-04-27T00:00:00Z"), undefined], [at("2026-07-27T00:00:00Z"), at("2026-08-24T00:00:00Z")],
  ]);
  // Hourly bars are not rounded: the day's first; with no bar within a month before it, the day itself.
  const hourly = ["2026-04-29T23:00:00Z", "2026-04-30T01:00:00Z", "2026-04-30T02:00:00Z"].map(at);
  expect(interventionChartEvents([markers[0]!], hourly, false)[0]!.time).toBe(at("2026-04-30T01:00:00Z"));
  expect(interventionChartEvents([markers[0]!], [at("2026-01-02T00:00:00Z")])[0]!.time).toBe(at("2026-04-30T00:00:00Z"));
});

function chart(symbol: string, transform: "raw" | "percent" = "raw"): { spec: ChartSpec; series: ReturnType<typeof createTestResolvedSeries>[] } {
  const spec = {
    series: [{ id: "price", source: { kind: "security", instrument: { symbol, exchange: "" }, fieldId: "market.ohlcv" }, transform, visible: true }],
  } as unknown as ChartSpec;
  const bars = createTestResolvedSeries({
    id: "price", label: symbol, color: "#00ff66", unit: "JPY", unitGroup: "currency", nativeFrequency: "daily", style: "candles",
    axis: "left", panelId: "main", interpolation: "none", points: ["2026-04-30", "2026-07-30"].map((date) => point(date, 150)),
  });
  return { spec, series: [bars] };
}

test("a chart marks interventions on a yen pair's raw price series only: not a transformed one, not the yen future", () => {
  const ids = (symbol: string, transform?: "percent") => {
    const { spec, series } = chart(symbol, transform);
    return chartInterventions(spec, series, record())?.events.map((event) => event.id) ?? null;
  };
  expect(ids("USDJPY=X")?.slice(-2)).toEqual(["mof:2026-04-30:USD:JPY", "mof:2026-07-30:2026-08-26"]);
  expect(ids("JPY=X")).toEqual(ids("USDJPY=X"));
  expect(ids("EURJPY=X")).toEqual(["mof:2003-05-08:JPY:EUR"]);
  expect(ids("USDJPY=X", "percent")).toBeNull();
  expect(ids("6J=F")).toBeNull();
  expect(ids("EURUSD=X")).toBeNull();
  const { spec, series } = chart("USDJPY=X");
  expect(chartInterventions(spec, series, null)).toBeNull();
  const marks = chartInterventions(spec, series, record())!;
  expect(marks.merge(marks.events.slice(2, 4))).toEqual(["MoF ¥9.2tn ×2 yen bought", "¥9.2tn ×2 yen bought", "¥9.2tn ×2"]);
});

test("one request serves every caller for ten minutes and a failed one for a minute; a reply this app cannot read is none", async () => {
  let now = 0, requests = 0;
  let answer: () => Promise<unknown> = async () => record();
  const load = createFxInterventionsLoader({ getCloudFxInterventions: () => { requests += 1; return answer() as never; } }, () => now);
  expect(await load()).not.toBeNull();
  now = 9 * 60_000;
  await load();
  expect(requests).toBe(1);
  now = 10 * 60_000;
  answer = async () => { throw new Error("404 Not Found"); };
  expect(await load()).toBeNull();
  now += 59_000;
  await load();
  expect(requests).toBe(2);
  now += 1_000;
  answer = async () => record();
  expect(await load()).not.toBeNull();
  expect(requests).toBe(3);

  expect(readFxInterventions({ ...record(), status: "unavailable" })).toBeNull();
  expect(readFxInterventions({ ...record(), interventions: [...record().interventions].reverse() })).toBeNull();
  expect(readFxInterventions({ ...record(), interventions: [run("2026-04-30", "2026-05-06", 3, -1, USD_SOLD)] })).toBeNull();
  expect(readFxInterventions({ ...record(), months: [{ ...record().months[2]!, undatedAmountJpy: 2e13 }] })).toBeNull();
  // An older reply without the interventions is none, never a guess.
  const { interventions: _dropped, ...older } = record();
  expect(readFxInterventions(older)).toBeNull();
});
