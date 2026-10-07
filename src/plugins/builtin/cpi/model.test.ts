import { describe, expect, test } from "bun:test";
import type { CpiBoardPayload, CpiRow } from "../../../api-client/cpi";
import { ApiRequestError } from "../../../api-client/errors";
import { CPI_NOT_AVAILABLE, fetchCpiBoard } from "./client";
import { cpiChartSeries, cpiHeaderLine, cpiRowLabel, cpiRowOption, cpiRows, formatCpiChange } from "./model";

/** Rows as the board served them for August 2026, history cut to the last three months. */
function row(id: string, overrides: Partial<CpiRow> = {}): CpiRow {
  return {
    id, code: null, label: id, depth: 1, parent: null, pinned: false, derived: false, weight: null, change: null,
    annualized3m: null, annualized6m: null, yoy: null, contribution: null, contributionYoy: null, read: null, history: [],
    ...overrides,
  };
}
const allItems = row("all-items", { code: "SA0", label: "All items", depth: 0, pinned: true, weight: 100, change: 0.396,
  annualized3m: 0.1822, annualized6m: 4.1159, yoy: 3.3965,
  history: [["2026-06", -0.4225, 3.5314], ["2026-07", 0.0737, 3.3648], ["2026-08", 0.396, 3.3965]] });
const core = row("core", { code: "SA0L1E", label: "Core (ex food and energy)", depth: 0, pinned: true, weight: 79.114,
  change: 0.2898, yoy: 2.446, contribution: 0.23, contributionYoy: 1.953 });
const gasoline = row("gasoline", { code: "SETB01", label: "Gasoline", parent: "energy", weight: 3.77, change: 3.8993, yoy: 27.4049,
  contribution: 0.14, contributionYoy: 0.87 });
const shelter = row("shelter", { code: "SAH1", label: "Shelter", parent: "core-services", weight: 35.343, change: 0.2638, yoy: 3.0411,
  contribution: 0.093, contributionYoy: 1.078,
  history: [["2025-10", null, null], ["2025-11", null, 3.0], ["2026-08", 0.2638, 3.0411]] });
const medical = row("medical-goods", { code: "SAM1", label: "Medical care goods", parent: "core-goods", weight: 1.403, change: -0.2298,
  yoy: -2.686, contribution: -0.003, contributionYoy: -0.04 });
const lodging = row("lodging", { code: "SEHB", label: "Lodging away from home", depth: 2, parent: "shelter", weight: 1.402 });

function board(overrides: Partial<CpiBoardPayload> = {}): CpiBoardPayload {
  return {
    source: "BLS", generatedAt: "2026-10-03T08:00:00.000Z", retrievedAt: "2026-10-03T07:45:00.000Z", status: "available", gaps: [],
    release: { period: "2026-08", releasedAt: "2026-09-11T12:30:00.000Z", weightsPeriod: "2026-07",
      nextPeriod: "2026-09", nextReleaseAt: "2026-10-14T12:30:00.000Z" },
    rows: [allItems, core, gasoline, medical, shelter, lodging],
    ...overrides,
  };
}

describe("CPI board boundary", () => {
  test("a server without the route, or without its months, is not available yet rather than an error", async () => {
    for (const status of [404, 503]) {
      const client = { getCloudCpiBoard: async () => { throw new ApiRequestError("Not Found", status); } };
      await expect(fetchCpiBoard(client)).rejects.toThrow(CPI_NOT_AVAILABLE);
    }
    const empty = board({ status: "unavailable", rows: [], release: { ...board().release, period: null, releasedAt: null } });
    await expect(fetchCpiBoard({ getCloudCpiBoard: async () => empty })).rejects.toThrow(CPI_NOT_AVAILABLE);
    const outage = { getCloudCpiBoard: async () => { throw new ApiRequestError("Bad gateway", 502); } };
    await expect(fetchCpiBoard(outage)).rejects.toThrow("Bad gateway");
  });

  test("a board that breaks the contract is refused whole", async () => {
    expect((await fetchCpiBoard({ getCloudCpiBoard: async () => board() })).rows).toHaveLength(6);
    for (const broken of [
      board({ rows: [allItems, { ...shelter, change: Number.NaN }] }),
      board({ rows: [allItems, { ...shelter, history: [["2026-13", 0.1, 3]] }] }),
      board({ rows: [allItems, allItems] }),
      board({ release: { ...board().release, period: "August 2026" } }),
    ]) {
      await expect(fetchCpiBoard({ getCloudCpiBoard: async () => broken })).rejects.toThrow("invalid consumer price board");
    }
  });
});

describe("CPI table", () => {
  test("all items and core stay on top under any sort; a sort puts empty values last and drops the indentation", () => {
    const ids = (sort?: Parameters<typeof cpiRows>[1]) => cpiRows(board(), sort).map((entry) => entry.id);
    expect(ids()).toEqual(["all-items", "core", "gasoline", "medical-goods", "shelter", "lodging"]);
    expect(ids({ columnId: "contribution", direction: "desc" })).toEqual(["all-items", "core", "gasoline", "shelter", "medical-goods", "lodging"]);
    expect(ids({ columnId: "contribution", direction: "asc" })).toEqual(["all-items", "core", "medical-goods", "shelter", "gasoline", "lodging"]);
    expect(cpiRowLabel(lodging, true)).toBe("\u00a0\u00a0\u00a0\u00a0Lodging away from home");
    expect(cpiRowLabel(lodging, false)).toBe("Lodging away from home");
    expect(formatCpiChange(-0.001)).toBe("0.00");
    expect(formatCpiChange(-0.2298)).toBe("-0.23");
  });

  test("the header names the month, its release and the next one on BLS's clock", () => {
    const { release } = board();
    expect(cpiHeaderLine(release, Date.parse("2026-10-03T08:00:00Z")))
      .toBe("Aug 2026 · released Fri Sep 11 08:30 ET · next Wed Oct 14 08:30 ET");
    // Past its time and not in yet: due, not next. Standard time from November.
    expect(cpiHeaderLine({ ...release, nextReleaseAt: "2026-12-10T13:30:00.000Z" }, Date.parse("2026-12-10T14:00:00Z")))
      .toBe("Aug 2026 · released Fri Sep 11 08:30 ET · due Thu Dec 10 08:30 ET");
    // Nothing listed yet after the last scheduled release.
    expect(cpiHeaderLine({ ...release, nextPeriod: null, nextReleaseAt: null })).toBe("Aug 2026 · released Fri Sep 11 08:30 ET");
    expect(cpiHeaderLine({ ...release, period: null })).toBeUndefined();
  });

  test("a typed component opens by id, label or the name traders use", () => {
    expect(cpiRowOption("shelter")?.value).toBe("shelter");
    expect(cpiRowOption("OER")?.value).toBe("oer");
    expect(cpiRowOption("supercore")?.value).toBe("services-ex-shelter");
    expect(cpiRowOption("Owners' equivalent rent")?.value).toBe("oer");
    expect(cpiRowOption("bitcoin")).toBeNull();
  });
});

describe("CPI chart", () => {
  const colors = { positive: "#00ff00", negative: "#ff0000", warning: "#ffaa00", textDim: "#888888" };

  test("monthly changes are columns on one axis, the yearly lines share the other, and missing months stay gaps", () => {
    const series = cpiChartSeries(shelter, allItems, colors);
    expect(series.map((entry) => [entry.label, entry.style, entry.axis, entry.unitGroup])).toEqual([
      ["Shelter m/m", "columns", "left", "cpi-month"],
      ["Shelter y/y", "line", "right", "cpi-year"],
      ["All items y/y", "line", "right", "cpi-year"],
    ]);
    expect(series[0]!.negativeColor).toBe("#ff0000");
    // October 2025 was never published: no point, not a zero.
    expect(series[0]!.points.map((point) => point.date.toISOString().slice(0, 7))).toEqual(["2026-08"]);
    expect(series[1]!.points).toHaveLength(2);
    // The headline is not drawn twice against itself.
    expect(cpiChartSeries(allItems, allItems, colors).map((entry) => entry.label)).toEqual(["All items m/m", "All items y/y"]);
  });
});
