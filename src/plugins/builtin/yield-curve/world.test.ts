import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { CloudCurveId, CloudCurveView, CloudWorldCurves } from "../../../api-client/yield-curves";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { createYieldCurveHeadless } from "./headless";
import { loadWorldRows, worldMissingNote } from "./world";

const points = (ten: number) => [{ tenor: "2Y", years: 2, yield: ten - 0.5 }, { tenor: "10Y", years: 10, yield: ten }];
const header = (id: CloudCurveId) => ({ id, label: id, country: id.toUpperCase(), basis: "par" as const, couponsPerYear: 2 });
const market = (id: CloudCurveId, asOf: string, ten: number) => ({ curve: header(id), asOf, points: points(ten), previous: null, checkedAt: null });

// `fn GC --tab world --date 2026-11-13` drew the 17 and 18 Nov sessions, as a server that reads no date sends them.
test("a board as of a date never shows a later session: a market sent one is read as of the date from its own curve", async () => {
  const world = { curves: [market("us", "2026-11-13", 4.1), market("jp", "2026-11-18", 1.9), market("br", "2026-11-17", 15)] } satisfies CloudWorldCurves;
  const asked: Array<[string, string | null | undefined]> = [];
  const client = {
    getCloudWorldCurves: async (date?: string | null) => { asked.push(["world", date]); return world; },
    getCloudCurve: async (id: CloudCurveId, date?: string | null): Promise<CloudCurveView> => {
      asked.push([id, date]);
      // Brazil has no session on or within ten days before the date.
      if (id === "br") throw new ApiRequestError("No Brazil curve on or within 10 days before 2026-11-13", 404);
      return {
        curve: header(id), requestedDate: date ?? null, asOf: "2026-11-13", points: points(1.8), spreads: [], checkedAt: null,
        lookbacks: [{ id: "1D", requestedDate: "2026-11-12", asOf: "2026-11-12", points: points(1.75) }],
      };
    },
  };
  const rows = await loadWorldRows(client, "2026-11-13");
  expect(asked).toEqual([["world", "2026-11-13"], ["jp", "2026-11-13"], ["br", "2026-11-13"]]);
  expect(rows.map((row) => [row.id, row.asOf, row.previousAsOf, row.tenYear, row.tenYearChange])).toEqual([
    ["us", "2026-11-13", null, 4.1, null],
    ["jp", "2026-11-13", "2026-11-12", 1.8, expect.closeTo(0.05, 10)],
  ]);
  expect(worldMissingNote(rows, "2026-11-13")).toBe("No session on or in the 10 days before 2026-11-13: Germany, UK, Canada, Euro AAA, Mexico and Brazil.");
  // The latest board asks for no date and reads every market as sent.
  expect((await loadWorldRows(client)).map((row) => row.asOf)).toEqual(["2026-11-13", "2026-11-18", "2026-11-17"]);
  expect(worldMissingNote(rows, "")).toBeNull();
});

test("fn GC --tab world takes the as-of date from --date or the argument, and says which markets it has no session for", async () => {
  const dates: string[] = [];
  const headless = createYieldCurveHeadless({
    load: async () => { throw new Error("The curve tab should not load for the world tab"); },
    world: async (_context, requestedDate) => {
      dates.push(requestedDate);
      return loadWorldRows({ getCloudWorldCurves: async () => ({ curves: [market("us", "2026-11-13", 4.1)] }), getCloudCurve: async () => { throw new Error("unused"); } }, requestedDate);
    },
  });
  const world = (options: Record<string, unknown>, argument: string | null = null) =>
    headless.load({ rawArgument: argument ?? "", argument, symbols: [], options: { tab: "world", ...options } }, {} as HeadlessPaneContext);
  const dated = await world({ date: "13.11.2026" });
  expect(dated.metadata).toMatchObject({ requestedDate: "2026-11-13" });
  expect(dated.freshness).toMatchObject({ basis: "historical curves" });
  expect(dated.notes?.[0]).toStartWith("No session on or in the 10 days before 2026-11-13: Germany");
  await world({}, "2026-11-13");
  const latest = await world({});
  expect(latest.notes).toBeUndefined();
  expect(dates).toEqual(["2026-11-13", "2026-11-13", ""]);
});
