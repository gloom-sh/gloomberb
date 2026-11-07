import { expect, test } from "bun:test";
import type { FxInterventionDay, FxInterventionsPayload } from "../api-client/fx-interventions";
import { interventionChartEvents } from "../plugins/builtin/chart-composer/intervention-events";
import {
  fxInterventionEpisodes,
  fxInterventionLatestNote,
  fxInterventionMarkers,
  fxInterventionPair,
  fxInterventionWindowNote,
  loadFxInterventions,
  readFxInterventions,
} from "./fx-interventions";

const USD_SOLD = { sold: "USD", bought: "JPY", pair: "the US dollar (sold) the Japanese yen (bought)" };
const USD_BOUGHT = { sold: "JPY", bought: "USD", pair: "the US dollar (bought) the Japanese yen (sold)" };
const EUR_BOUGHT = { sold: "JPY", bought: "EUR", pair: "the Euro (bought) the Japanese yen (sold)" };
const operation = (date: string, billions: number, side: Omit<FxInterventionDay, "date" | "amountJpy">): FxInterventionDay => (
  { date, amountJpy: Math.round(billions * 1e9), ...side }
);

/** The ministry's record as served on 7 Nov 2026, cut to a few episodes: July 2026's total has no days yet. */
function record(): FxInterventionsPayload {
  return {
    authority: "Japan Ministry of Finance",
    status: "available",
    days: [
      operation("2003-05-08", 41.4, EUR_BOUGHT), operation("2003-05-09", 41.5, EUR_BOUGHT),
      operation("2010-09-15", 2124.9, USD_BOUGHT),
      operation("2011-10-31", 8072.2, USD_BOUGHT), operation("2011-11-01", 1019.5, USD_BOUGHT),
      operation("2022-09-22", 2838.2, USD_SOLD),
      operation("2022-10-21", 5620.2, USD_SOLD), operation("2022-10-24", 729.6, USD_SOLD),
      operation("2024-04-29", 5918.5, USD_SOLD), operation("2024-05-01", 3870, USD_SOLD),
      operation("2024-07-11", 3167.8, USD_SOLD), operation("2024-07-12", 2367, USD_SOLD),
      operation("2026-04-30", 6278.7, USD_SOLD), operation("2026-05-04", 780.2, USD_SOLD), operation("2026-05-06", 4675.9, USD_SOLD),
    ],
    dailyThrough: "2026-06-30",
    months: [
      // Its days are out: not an undated total.
      { from: "2026-04-28", to: "2026-05-27", amountJpy: 11_734_900_000_000 },
      { from: "2026-06-29", to: "2026-07-29", amountJpy: 0 },
      { from: "2026-07-30", to: "2026-08-26", amountJpy: 15_399_300_000_000, releasedOn: "2026-08-28" },
      { from: "2026-09-29", to: "2026-10-28", amountJpy: 0 },
    ],
    quarters: [],
    fetchedAt: "2026-11-07T07:37:53.746Z",
    sourceUrl: "https://www.mof.go.jp/english/policy/international_policy/reference/feio/index.html",
    notes: [],
  };
}

const USDJPY = { base: "USD", quote: "JPY" };

test("operations a weekend or a holiday apart in one pair and direction are one episode; the pair is the listing's either way round", () => {
  expect(fxInterventionEpisodes(record().days, USDJPY).map(({ from, to, days, amountJpy, sold }) => [from, to, days, amountJpy, sold])).toEqual([
    ["2010-09-15", "2010-09-15", 1, 2_124_900_000_000, "JPY"],
    ["2011-10-31", "2011-11-01", 2, 9_091_700_000_000, "JPY"],
    ["2022-09-22", "2022-09-22", 1, 2_838_200_000_000, "USD"],
    // A Friday and the Monday after.
    ["2022-10-21", "2022-10-24", 2, 6_349_800_000_000, "USD"],
    ["2024-04-29", "2024-05-01", 2, 9_788_500_000_000, "USD"],
    ["2024-07-11", "2024-07-12", 2, 5_534_800_000_000, "USD"],
    // Golden Week: 30 Apr, then 4 and 6 May.
    ["2026-04-30", "2026-05-06", 3, 11_734_800_000_000, "USD"],
  ]);
  expect(fxInterventionPair("JPY=X")).toEqual(USDJPY);
  expect(fxInterventionPair("EURJPY=X")).toEqual({ base: "EUR", quote: "JPY" });
  expect(fxInterventionPair("EURUSD=X")).toBeNull();
  expect(fxInterventionEpisodes(record().days, { base: "JPY", quote: "EUR" }).map((episode) => episode.from)).toEqual(["2003-05-08"]);
});

test("fx names the total the ministry has reported without days, then the pair's last dated episode, and how far its records run", () => {
  expect(fxInterventionLatestNote(record(), USDJPY)).toBe(
    "Japan's Ministry of Finance reported ¥15,399.3 billion of intervention from 30 Jul to 26 Aug 2026, a monthly total: its days and pair come with the quarterly release. "
    + "Its last dated intervention in USD/JPY: 30 Apr–6 May 2026, ¥11,734.8 billion of dollars sold for yen on 3 days. Records through 28 Oct 2026.",
  );
  // Once the quarter is out, the total has days and is not repeated.
  const released = { ...record(), dailyThrough: "2026-09-30", days: [...record().days, operation("2026-07-30", 15399.3, USD_SOLD)] };
  expect(fxInterventionLatestNote(released, USDJPY)).toBe(
    "Japan's Ministry of Finance last intervened in USD/JPY: 30 Jul 2026, ¥15,399.3 billion of dollars sold for yen. Records through 28 Oct 2026.",
  );
  expect(fxInterventionLatestNote({ ...released, days: [] }, { base: "GBP", quote: "JPY" })).toBeNull();
});

test("history names the episodes its bars span, the newest six with the older ones counted, and a total without days", () => {
  expect(fxInterventionWindowNote(record(), USDJPY, "2024-04-01", "2024-08-01")).toBe(
    "Japan's Ministry of Finance intervened in USD/JPY in these bars: 29 Apr–1 May 2024, ¥9,788.5 billion of dollars sold for yen on 2 days; "
    + "11–12 Jul 2024, ¥5,534.8 billion of dollars sold for yen on 2 days.",
  );
  expect(fxInterventionWindowNote(record(), USDJPY, "2001-01-02", "2026-11-06")).toBe(
    "Japan's Ministry of Finance intervened in USD/JPY in these bars: 31 Oct–1 Nov 2011, ¥9,091.7 billion of yen sold for dollars on 2 days; 22 Sep 2022, ¥2,838.2 billion of dollars sold for yen; "
    + "21–24 Oct 2022, ¥6,349.8 billion of dollars sold for yen on 2 days; 29 Apr–1 May 2024, ¥9,788.5 billion of dollars sold for yen on 2 days; "
    + "11–12 Jul 2024, ¥5,534.8 billion of dollars sold for yen on 2 days; 30 Apr–6 May 2026, ¥11,734.8 billion of dollars sold for yen on 3 days; "
    + "and 1 earlier from 15 Sep 2010. It also reported ¥15,399.3 billion of intervention from 30 Jul to 26 Aug 2026, a monthly total: its days and pair come with the quarterly release.",
  );
  expect(fxInterventionWindowNote(record(), USDJPY, "2026-10-01", "2026-11-06")).toBeNull();
});

test("each episode is a chart marker on the bar of its first day; a total without days is dotted at its period's first day", () => {
  const markers = fxInterventionMarkers(record(), USDJPY);
  expect(markers.slice(-2)).toEqual([
    { id: "mof:2026-04-30:USD:JPY", date: "2026-04-30", label: "MoF ¥11.7tn", undated: false },
    { id: "mof:2026-07-30:2026-08-26", date: "2026-07-30", label: "MoF ¥15.4tn 30 Jul–26 Aug", undated: true },
  ]);
  const at = (date: string) => Date.parse(date);
  // Daily bars: the day's own; weekly bars dated by their Monday: the week's.
  const daily = ["2026-04-29", "2026-04-30", "2026-05-01", "2026-07-30"].map((date) => at(`${date}T00:00:00Z`));
  expect(interventionChartEvents(markers.slice(-2), daily).map((event) => [event.time, event.dotted ?? false]))
    .toEqual([[at("2026-04-30T00:00:00Z"), false], [at("2026-07-30T00:00:00Z"), true]]);
  const weekly = ["2026-04-27", "2026-07-27"].map((date) => at(`${date}T00:00:00Z`));
  expect(interventionChartEvents(markers.slice(-2), weekly).map((event) => event.time)).toEqual([at("2026-04-27T00:00:00Z"), at("2026-07-27T00:00:00Z")]);
  // Hourly bars: the day's first; with no bar within a month before it, the day itself.
  const hourly = ["2026-04-29T23:00:00Z", "2026-04-30T01:00:00Z", "2026-04-30T02:00:00Z"].map(at);
  expect(interventionChartEvents([markers.at(-2)!], hourly)[0]!.time).toBe(at("2026-04-30T01:00:00Z"));
  expect(interventionChartEvents([markers.at(-2)!], [at("2026-01-02T00:00:00Z")])[0]!.time).toBe(at("2026-04-30T00:00:00Z"));
});

test("a reply that is not a record this app can read is none, and an unreachable server answers none instead of failing", async () => {
  expect(readFxInterventions(record())).not.toBeNull();
  expect(readFxInterventions({ ...record(), status: "unavailable" })).toBeNull();
  expect(readFxInterventions({ ...record(), days: [...record().days].reverse() })).toBeNull();
  expect(readFxInterventions({ ...record(), days: [operation("2026-04-30", -1, USD_SOLD)] })).toBeNull();
  expect(readFxInterventions({ ...record(), months: [{ from: "2026-08-26", to: "2026-07-30", amountJpy: 1 }] })).toBeNull();
  const unreachable = { getCloudFxInterventions: async () => { throw new Error("404 Not Found"); } };
  expect(await loadFxInterventions(unreachable as never)).toBeNull();
});
