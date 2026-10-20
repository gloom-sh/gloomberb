import { expect, test } from "bun:test";
import {
  basisPointsCell,
  filterFredSeries,
  fredChangeFetchStart,
  fredChangeMismatch,
  fredChanges,
  fredEmptyAdvice,
  fredEmptyMessage,
  fredDecimals,
  fredExportValue,
  fredHistoryNotes,
  fredInterval,
  fredObservationsFromStart,
  fredPublicationTime,
  fredUnit,
  fredValueCell,
  isSpreadSeries,
  laggingSeriesNote,
  parseFredChange,
} from "./fred-series";

test("a table prints every observation at the series' precision, which FRED's dropped zeros and float noise do not lower or raise", () => {
  // FRED serves 5.10 and 5.00 as 5.1 and 5; beside 5.09 they print as 5.10 and 5.00.
  const cell = fredValueCell(fredDecimals([5.09, 5.1, 5, null]));
  expect([5.09, 5.1, 5, null].map(cell)).toEqual(["5.09", "5.10", "5.00", ""]);
  expect(fredDecimals([0.9499999999999886, 16.532])).toBe(3);
  expect(fredDecimals([32563.03, 31906.274])).toBe(3);
  expect(fredDecimals([null])).toBe(0);
});

test("--change takes 1D or 1W in any case, and a daily or weekly series", () => {
  expect(["1D", "1w", " 1W ", "2D", "1M", "", undefined].map(parseFredChange)).toEqual(["1D", "1W", "1W", null, null, null, null]);
  expect(fredChangeMismatch("WALCL", "weekly", "1W")).toBeNull();
  expect(fredChangeMismatch("WALCL", "weekly", "1D")).toBe("WALCL is weekly, so its changes are 1W.");
  expect(fredChangeMismatch("UNRATE", "monthly", "1W")).toMatch(/^UNRATE is monthly/);
  // A week and the ten-day window before the start, across a month end.
  expect(fredChangeFetchStart("2026-10-01")).toBe("2026-09-14");
});

test("a spread's changes come in basis points and a holiday keeps no change", () => {
  const spread = fredChanges("T10Y2Y", [
    { date: "2026-10-13", value: 0.42 },
    { date: "2026-10-12", value: null },
    { date: "2026-10-09", value: 0.44 },
  ], "1D");
  expect([...spread]).toEqual([["2026-10-13", { change: -2, changeFrom: "2026-10-09" }]]);
  expect(fredChanges("DGS10", [{ date: "2026-10-15", value: 5.1 }, { date: "2026-10-16", value: 5.09 }], "1D").get("2026-10-16"))
    .toEqual({ change: -0.01, changeFrom: "2026-10-15" });
});

test("spreads export in basis points, FRED's other series as they come", () => {
  expect(["t10y2y", "T10Y3M", "BAMLH0A0HYM2", "DGS10", "T10YIE"].map(isSpreadSeries)).toEqual([true, true, true, false, false]);
  // Percentage points to bp without float noise: 3.15 * 100 is 315.00000000000006.
  expect([3.15, 0.44, -0.125, 0.07, null].map((value) => fredExportValue("BAMLH0A0HYM2", value))).toEqual([315, 44, -12.5, 7, null]);
  expect(fredExportValue("DGS10", 5.24)).toBe(5.24);
  expect([44, -12.5, 315.04, -0.04, null, "n/a"].map(basisPointsCell)).toEqual(["44", "-12.5", "315", "0", "", ""]);
});

test("the unit column names a spread bp, a percent pct and anything else as FRED states it", () => {
  expect(fredUnit("BAMLH0A0HYM2", { units: "Percent" })).toBe("bp");
  expect(fredUnit("DGS10", { units: "Percent" })).toBe("pct");
  expect(fredUnit("CPIAUCSL", { units: "Index 1982-1984=100" })).toBe("Index 1982-1984=100");
  expect(fredUnit("GDP", { units: "Billions of Dollars", seasonalAdjustment: "Seasonally Adjusted Annual Rate" })).toBe("Billions of Dollars, annual rate");
  // A spread is in bp whatever the metadata says; without it any other series has no unit to state.
  expect(fredUnit("T10Y2Y", null)).toBe("bp");
  expect(fredUnit("DGS10", undefined)).toBeNull();
  expect(["Daily", "Weekly, Ending Friday", "Monthly", "", null].map(fredInterval)).toEqual(["daily", "weekly", "monthly", null, null]);
});

test("a start before the series begins drops the blank days before it, and keeps a blank holiday after it", () => {
  const observations = [
    { date: "1979-12-28", value: null }, { date: "1979-12-31", value: null },
    { date: "1980-01-02", value: 0.8271 }, { date: "1980-01-03", value: null }, { date: "1980-01-04", value: 0.8268 },
  ];
  const kept = ["1980-01-02", "1980-01-03", "1980-01-04"];
  expect(fredObservationsFromStart(observations, "1980-01-02").map((row) => row.date)).toEqual(kept);
  // Newest first, as --sort desc serves it.
  expect(fredObservationsFromStart([...observations].reverse(), "1980-01-02").map((row) => row.date)).toEqual([...kept].reverse());
  // Without FRED's metadata, the first value marks the start.
  expect(fredObservationsFromStart(observations, null).map((row) => row.date)).toEqual(kept);
  // A blank row at the start asked for, inside the series, is a holiday and stays.
  expect(fredObservationsFromStart([{ date: "2021-01-01", value: null }, { date: "2021-01-04", value: 14.6 }], "1980-01-02")).toHaveLength(2);
});

test("FRED's last update is the publication time only when it covers the newest observation", () => {
  const info = { lastUpdated: "2026-10-09 08:08:04-05", observationEnd: "2026-10-08" };
  expect(fredPublicationTime(info, "2026-10-08")).toBe("2026-10-09T13:08:04.000Z");
  // Metadata from before the newest observation says nothing about when it was published.
  expect(fredPublicationTime(info, "2026-10-09")).toBeNull();
  expect(fredPublicationTime({ lastUpdated: info.lastUpdated }, "2026-10-08")).toBeNull();
  expect(fredPublicationTime({ ...info, lastUpdated: "2026-10-09" }, "2026-10-08")).toBeNull();
  expect(fredPublicationTime(null, "2026-10-08")).toBeNull();
});

test("says where the history starts when the default start hides older data, or the series begins after the start asked for", () => {
  const input = { startDate: "2021-01-01", startGiven: false, seriesStart: "1976-06-01" };
  expect(fredHistoryNotes(input)).toEqual(["Showing from 2021-01-01; earlier: --start YYYY-MM-DD (series begins 1976-06-01)."]);
  // A start the caller chose needs no pointer, but a series that begins later says so.
  expect(fredHistoryNotes({ ...input, startGiven: true })).toEqual([]);
  expect(fredHistoryNotes({ ...input, startDate: "1960-01-01", startGiven: true })).toEqual(["Series begins 1976-06-01."]);
  // A series that begins after the default start is not hidden by it.
  expect(fredHistoryNotes({ ...input, seriesStart: "2023-02-01" })).toEqual(["Series begins 2023-02-01."]);
  // Without metadata nothing is claimed.
  expect(fredHistoryNotes({ ...input, seriesStart: undefined })).toEqual([]);
  expect(fredHistoryNotes({ ...input, seriesStart: "not a date" })).toEqual([]);
});

test("an empty window names the latest observation, or says no results when there is none", () => {
  expect(fredEmptyMessage("2026-10-11", { date: "2026-10-09", value: 5.24 }))
    .toBe("Latest observation: 2026-10-09 (5.24). Nothing on or after 2026-10-11.");
  expect(fredEmptyMessage("2026-10-11", { date: "2026-10-09", value: null })).toBe("Latest observation: 2026-10-09. Nothing on or after 2026-10-11.");
  expect(fredEmptyMessage("2026-10-11", null)).toBe("No results.");
  // A CSV of nothing fails with a start that reaches the latest observation.
  expect(fredEmptyAdvice("DGS10", { date: "2026-10-09" })).toBe("Latest observation: 2026-10-09. Try: gloomberb fred DGS10 --start 2026");
});

test("a lagging series carries its note, in any case", () => {
  expect(laggingSeriesNote("umcsent")).toContain("fn ECO");
  expect(laggingSeriesNote("DGS10")).toBeNull();
});

test("fred --list ranks the group and title words a filter names above an id that only contains it", () => {
  const rows = [
    { id: "FDEFX", title: "Federal Government: National Defense Consumption Expenditures and Gross Investment", group: "Defense & fiscal" },
    { id: "DEXBZUS", title: "Brazilian Reals to U.S. Dollar Spot Exchange Rate (BRL per USD)", group: "FX" },
    { id: "DEXJPUS", title: "Japanese Yen to U.S. Dollar Spot Exchange Rate (JPY per USD)", group: "FX" },
    { id: "CPIAUCSL", title: "Consumer Price Index", group: "Prices" },
    { id: "CORESTICKM159SFRBATL", title: "Sticky Price CPI", group: "Prices" },
    { id: "EXFX", title: "Cross rates of the Swiss franc", group: "Rates" },
    { id: "TURCPIYOY", title: "Consumer Price Index for Türkiye, Percent Change from Year Ago", group: "Inflation" },
  ];
  const ids = (filter: string) => filterFredSeries(rows, filter).map((row) => row.id);
  // The FX group, in catalog order, then the ids that spell fx.
  expect(ids("fx")).toEqual(["DEXBZUS", "DEXJPUS", "FDEFX", "EXFX"]);
  // A word of the title beats an id with the letters inside, and an exact id is found whole.
  expect(ids("cpi")).toEqual(["CORESTICKM159SFRBATL", "CPIAUCSL", "TURCPIYOY"]);
  // Accents are not needed: turk finds Türkiye as a word of its title.
  expect(ids("turk")).toEqual(["TURCPIYOY"]);
  expect(ids("türkiye")).toEqual(["TURCPIYOY"]);
  expect(ids("cpiaucsl")).toEqual(["CPIAUCSL"]);
  expect(ids("def")).toEqual(["FDEFX"]);
  // Every word must match somewhere; the best match of each word ranks the row.
  expect(ids("fx japanese")).toEqual(["DEXJPUS"]);
  expect(ids("price sticky")).toEqual(["CORESTICKM159SFRBATL"]);
  expect(ids("nothing")).toEqual([]);
  // No filter keeps the catalog as it is.
  expect(ids("")).toEqual(rows.map((row) => row.id));
});
