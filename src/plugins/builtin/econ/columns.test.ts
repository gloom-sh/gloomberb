import { describe, expect, test } from "bun:test";
import { hiddenTableColumnText, tableColumnWidth } from "../../../components/ui/table-layout";
import { longestEventName } from "./calendar-model";
import { econCalendarColumns } from "./columns";
import type { EconEvent } from "./types";

const release = (id: string, at: string, country: string, event: string, actual: string | null, forecast: string | null, prior: string | null,
  currency?: string): EconEvent => ({ id, date: new Date(`${at}Z`), time: at.slice(11, 16), country, event, impact: "high", actual, forecast, prior,
  ...(currency ? { currency } : {}) });

/**
 * A browser's first screen of high-impact releases: names up to 31 cells, figures of four or five, and the long figures
 * that set each column's width out of view: last week's trade balance, and weeks out another one and the Fed's range.
 */
const LISTING = [
  release("us-trade", "2026-11-20T13:30", "US", "Balance of Trade", "-52.8B", "-55B", "-59.6B", "USD"),
  release("fr-cpi", "2026-11-27T07:45", "FR", "French Inflation Rate YoY Prel", "2.9%", "3.2%", "3.1%"),
  release("de-jobs", "2026-11-27T08:55", "DE", "German Unemployed Persons NSA", null, null, "2.95M"),
  release("cn-pmi", "2026-11-30T01:30", "CN", "NBS Manufacturing PMI", null, "49.4", "49.2"),
  release("it-cpi", "2026-11-30T10:00", "IT", "Italian Inflation Rate YoY Prel", null, null, "1.2%"),
  release("ca-gdp", "2026-11-30T13:30", "CA", "GDP Growth Rate Annualized", null, null, "-1.6%"),
  release("cn-rd", "2026-12-01T01:45", "CN", "RatingDog Manufacturing PMI", null, "51.5", "50.6"),
  release("eu-cpi", "2026-12-01T10:00", "EU", "Inflation Rate YoY Flash", null, "4%", "2.1%"),
  release("au-trade", "2026-12-03T00:30", "AU", "Balance of Trade", null, "1.561B", "3.938B", "AUD"),
  release("fed", "2026-12-09T19:00", "US", "Fed Interest Rate Decision", null, "3.50-3.75%", "3.75-4.00%"),
];

const columnsAt = (width: number, flagged = false, events: readonly EconEvent[] = LISTING) =>
  econCalendarColumns({ width, events, countryFilter: "all", impactFilter: "high", flagged, readerZone: null }).columns;
const widths = (width: number, flagged = false) =>
  Object.fromEntries(columnsAt(width, flagged).map((column) => [column.label, column.width]));

describe("econ calendar column widths", () => {
  // At 57 cells, the browser's first screen, the names stopped at "French Inflation Rate …" beside ACT and EST of ten
  // cells each, set by figures out of view: the names now have those cells, and the long figures are cut instead.
  test("the names have what a long figure took, at every width, before a column keeps more than a plain figure", () => {
    expect(widths(40)).toEqual({ UTC: 5, CTY: 3, EVENT: 16, ACT: 7 });
    expect(widths(48)).toEqual({ UTC: 5, CTY: 3, EVENT: 16, ACT: 7, EST: 7 });
    expect(widths(53)).toEqual({ UTC: 5, CTY: 3, EVENT: 21, ACT: 7, EST: 7 });
    expect(widths(57, true)).toEqual({ UTC: 5, CTY: 5, EVENT: 25, ACT: 7, EST: 7 });
    expect(widths(60)).toEqual({ UTC: 5, CTY: 3, EVENT: 24, ACTUAL: 8, FORECAST: 10 });
    // All three columns kept: they give up their cells too, only as many as the longest name needs.
    expect(widths(80)).toEqual({ UTC: 5, COUNTRY: 9, EVENT: 31, ACTUAL: 8, FORECAST: 10, PRIOR: 8 });
    // A phone: 48 cells with the flags.
    expect(widths(48, true)).toEqual({ UTC: 5, CTY: 5, EVENT: 16, ACT: 7, EST: 7 });
    // With room for every name, a long figure is whole.
    expect(widths(110)).toEqual({ UTC: 5, COUNTRY: 9, EVENT: 57, ACTUAL: 10, FORECAST: 10, PRIOR: 10 });

    const longest = longestEventName(LISTING);
    for (const flagged of [false, true]) for (let width = 36; width <= 120; width += 1) {
      const columns = columnsAt(width, flagged);
      const event = columns.find((column) => column.id === "event")!;
      if (event.width >= longest) continue;
      for (const figure of columns.filter((column) => ["actual", "forecast", "prior"].includes(column.id))) {
        expect({ width, flagged, column: figure.id, cells: figure.width })
          .toEqual({ width, flagged, column: figure.id, cells: Math.min(figure.width, Math.max(7, tableColumnWidth({ width: 1, label: figure.label }))) });
      }
    }
  });

  // What the narrow pane leaves out is decided as it was: PRIOR under 20 cells of name, the forecast under 14.
  test("leaves out PRIOR and then the forecast where it did, and says so", () => {
    const hidden = (width: number, flagged = false) => hiddenTableColumnText(columnsAt(width, flagged));
    expect(hidden(40)).toBe("2 hidden · EST, PRIOR");
    expect(hidden(48)).toBe("1 hidden · PRIOR");
    expect(hidden(48, true)).toBe("1 hidden · PRIOR");
    expect(hidden(66)).toBe("1 hidden · PRIOR");
    expect(hidden(70)).toBeNull();
  });

  // Where no figure listed needs a plain figure's cells, a column is as narrow as its widest figure or its header.
  test("a column of short figures is narrower than a plain figure", () => {
    const near = LISTING.filter((event) => !["us-trade", "au-trade", "fed"].includes(event.id));
    expect(Object.fromEntries(columnsAt(57, true, near).map((column) => [column.label, column.width])))
      .toEqual({ UTC: 5, CTY: 5, EVENT: 21, ACT: 5, EST: 5, PRIOR: 7 });
  });
});
