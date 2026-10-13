import { expect, test } from "bun:test";
import {
  basisPointsCell,
  filterFredSeries,
  fredEmptyMessage,
  fredExportValue,
  fredHistoryNotes,
  fredPublicationTime,
  fredValueKey,
  isSpreadSeries,
  laggingSeriesNote,
} from "./fred-series";

test("spreads export in basis points, FRED's other series as they come", () => {
  expect(["t10y2y", "T10Y3M", "BAMLH0A0HYM2", "DGS10", "T10YIE"].map(isSpreadSeries)).toEqual([true, true, true, false, false]);
  // Percentage points to bp without float noise: 3.15 * 100 is 315.00000000000006.
  expect([3.15, 0.44, -0.125, 0.07, null].map((value) => fredExportValue("BAMLH0A0HYM2", value))).toEqual([315, 44, -12.5, 7, null]);
  expect(fredExportValue("DGS10", 5.24)).toBe(5.24);
  expect([44, -12.5, 315.04, -0.04, null, "n/a"].map(basisPointsCell)).toEqual(["44", "-12.5", "315", "0", "", ""]);
});

test("every export names its unit in the value column, never a bare value", () => {
  expect(fredValueKey("BAMLH0A0HYM2", "Percent")).toBe("value_bp");
  expect(fredValueKey("DGS10", "Percent")).toBe("value_pct");
  expect(fredValueKey("CPIAUCSL", "Index 1982-1984=100")).toBe("value_index_1982_1984_100");
  expect(fredValueKey("GDP", "Billions of Dollars")).toBe("value_billions_of_dollars");
  expect(fredValueKey("T10YIE", "Percent Change from Year Ago")).toBe("value_percent_change_from_year_ago");
  // Without FRED's metadata the unit is said to be unknown, not left out.
  expect(fredValueKey("DGS10", undefined)).toBe("value_unit_unknown");
  expect(fredValueKey("T10Y2Y", undefined)).toBe("value_bp");
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
  ];
  const ids = (filter: string) => filterFredSeries(rows, filter).map((row) => row.id);
  // The FX group, in catalog order, then the ids that spell fx.
  expect(ids("fx")).toEqual(["DEXBZUS", "DEXJPUS", "FDEFX", "EXFX"]);
  // A word of the title beats an id with the letters inside, and an exact id is found whole.
  expect(ids("cpi")).toEqual(["CORESTICKM159SFRBATL", "CPIAUCSL"]);
  expect(ids("cpiaucsl")).toEqual(["CPIAUCSL"]);
  expect(ids("def")).toEqual(["FDEFX"]);
  // Every word must match somewhere; the best match of each word ranks the row.
  expect(ids("fx japanese")).toEqual(["DEXJPUS"]);
  expect(ids("price sticky")).toEqual(["CORESTICKM159SFRBATL"]);
  expect(ids("nothing")).toEqual([]);
  // No filter keeps the catalog as it is.
  expect(ids("")).toEqual(rows.map((row) => row.id));
});
