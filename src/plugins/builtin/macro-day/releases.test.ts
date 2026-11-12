import { afterEach, describe, expect, test } from "bun:test";
import type { CloudMacroReleaseDaysPayload } from "../../../api-client";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { loadMacroReleases, macroReleaseCache } from "./client";
import { bundledMacroReleases, mergeMacroReleases, staleMacroReleasesNotice, type MacroReleaseList } from "./releases";

const floor: MacroReleaseList = { coveredThrough: "2026-10-01", releases: [{ kind: "jobs", date: "2026-09-04" }, { kind: "fomc", date: "2026-09-16" }] };
const served = (coveredThrough: string, releases: Partial<CloudMacroReleaseDaysPayload["releases"]> = {}): CloudMacroReleaseDaysPayload => ({
  checkedAt: `${coveredThrough}T22:00:00Z`, coveredThrough, sources: [], releases: { cpi: [], jobs: [], fomc: [], ...releases },
});

afterEach(() => macroReleaseCache.reset());

describe("macro release list", () => {
  test("a served list only extends the floor past its end, up to its own", () => {
    const merged = mergeMacroReleases(floor, served("2026-10-09", {
      // Before the floor's end the floor speaks; past the served end a date is only scheduled.
      jobs: ["2026-09-04", "2026-09-25", "2026-10-02", "2026-11-06"], cpi: ["2026-10-14"],
    }));
    expect(merged.coveredThrough).toBe("2026-10-09");
    expect(merged.releases).toEqual([...floor.releases, { kind: "jobs", date: "2026-10-02" }]);

    // Malformed or missing lists leave the floor as it is.
    for (const payload of [served("2026-10-09", { jobs: ["10/02/2026"] }),
      { coveredThrough: "2026-10-09", releases: { cpi: [], jobs: ["2026-10-02"] } }, null]) {
      expect(mergeMacroReleases(floor, payload)).toBe(floor);
    }
    // One that ends no later than the floor adds no day.
    expect(mergeMacroReleases(floor, served("2026-10-01", { jobs: ["2026-10-02"] }))).toEqual(floor);
  });

  test("a day the floor carries keeps the figures the server has, whether or not the server reaches past the floor's end", () => {
    const hold = { event: "Federal funds target range", actual: "3.75-4.00%", forecast: "3.75-4.00%", prior: "3.75-4.00%",
      surprise: "in-line" as const, decision: "held" };
    const bundled = bundledMacroReleases();
    const day = bundled.releases.findLast((release) => release.kind === "fomc")!;
    const figures = { fomc: { [day.date]: hold } };
    // The server's list ends before the bundled one, on it, and past it: the day is the bundled one's each time, with its figures.
    const shift = (days: number) => new Date(Date.parse(`${bundled.coveredThrough}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    for (const through of [shift(-5), bundled.coveredThrough, shift(5)]) {
      const merged = mergeMacroReleases(bundled, { ...served(through, { fomc: [day.date] }), figures, figuresFrom: "2026-01-02" });
      expect(merged.releases.find((release) => release.kind === "fomc" && release.date === day.date)?.figures).toEqual(hold);
      expect(merged.figuresFrom).toBe("2026-01-02");
      expect(merged.coveredThrough).toBe(through > bundled.coveredThrough ? through : bundled.coveredThrough);
    }

    // So do the reason a floor day has none, and the IPCA days through the server's end.
    const behind = mergeMacroReleases(floor, { ...served("2026-09-30", { ipca: ["2026-09-11", "2026-10-09"] }),
      figureGaps: { jobs: { "2026-09-04": "the economic calendar has no Non Farm Payrolls row that day" } } });
    expect(behind.coveredThrough).toBe(floor.coveredThrough);
    expect(behind.releases).toEqual([{ kind: "jobs", date: "2026-09-04", figuresMissing: "the economic calendar has no Non Farm Payrolls row that day" },
      { kind: "ipca", date: "2026-09-11" }, { kind: "fomc", date: "2026-09-16" }]);
  });

  test("takes the served IPCA days through the list's end, and every day's figures the server has", () => {
    const hot = { event: "Inflation Rate YoY", actual: "3.7%", forecast: "3.6%", prior: "3.4%", surprise: "hot" as const };
    const merged = mergeMacroReleases(floor, {
      ...served("2026-10-23", { cpi: ["2026-10-14"], ipca: ["2026-09-11", "2026-10-09", "2026-11-10"] }),
      figures: {
        cpi: { "2026-10-14": hot },
        // A floor day takes the server's figures too; one that breaks the contract is left without.
        fomc: { "2026-09-16": { event: "Fed Interest Rate Decision", actual: "4%", forecast: "4%", prior: "3.75%", surprise: "in-line" } },
        jobs: { "2026-09-04": { actual: "162K" } },
        ipca: { "2026-10-09": { event: "IPCA m/m", actual: "0.82%", forecast: null, prior: "-0.32%", surprise: "sideways" } },
      },
    });
    expect(merged.releases).toEqual([
      { kind: "jobs", date: "2026-09-04" },
      { kind: "ipca", date: "2026-09-11" },
      { kind: "fomc", date: "2026-09-16", figures: { event: "Fed Interest Rate Decision", actual: "4%", forecast: "4%", prior: "3.75%", surprise: "in-line" } },
      { kind: "ipca", date: "2026-10-09", figures: { event: "IPCA m/m", actual: "0.82%", forecast: null, prior: "-0.32%", surprise: null } },
      { kind: "cpi", date: "2026-10-14", figures: hot },
    ]);
    // A server without IPCA, or with a broken list of it, still extends the US days.
    expect(mergeMacroReleases(floor, served("2026-10-23", { cpi: ["2026-10-14"], ipca: ["9 Oct"] } as never)).releases)
      .toEqual([...floor.releases, { kind: "cpi", date: "2026-10-14" }]);
  });

  test("a policy decision's move and the reason a covered day has no figures come with the days", () => {
    const merged = mergeMacroReleases(floor, {
      ...served("2026-11-06", { jobs: ["2026-11-06"], fomc: ["2026-10-28"] }), figuresFrom: "2026-01-02",
      figures: { fomc: { "2026-10-28": { event: "Federal funds target range", actual: "3.75-4.00%", forecast: "3.75-4.00%",
        prior: "3.75-4.00%", surprise: "in-line", decision: "held" } } },
      figureGaps: { jobs: { "2026-11-06": "the economic calendar has no Non Farm Payrolls row that day" } },
    });
    expect(merged.figuresFrom).toBe("2026-01-02");
    expect(merged.releases.find((release) => release.date === "2026-10-28")?.figures?.decision).toBe("held");
    expect(merged.releases.find((release) => release.date === "2026-11-06")).toEqual({ kind: "jobs", date: "2026-11-06",
      figuresMissing: "the economic calendar has no Non Farm Payrolls row that day" });
  });

  test("a failed read keeps the last list read, and the bundled one without any", async () => {
    macroReleaseCache.attach(new MemoryPluginPersistence());
    const down = () => Promise.reject(new Error("offline"));
    expect(await loadMacroReleases({}, down)).toEqual(bundledMacroReleases());
    const later = bundledMacroReleases().coveredThrough.replace(/^\d{4}/, (year) => String(Number(year) + 1));
    await loadMacroReleases({ force: true }, async () => served(later, { jobs: [later] }));
    const kept = await loadMacroReleases({ force: true }, down);
    expect(kept.coveredThrough).toBe(later);
    expect(kept.releases.at(-1)).toEqual({ kind: "jobs", date: later });
  });

  test("says so once the list ends more than two weeks before today in New York", () => {
    // 02:00 UTC on 16 October is still 15 October in New York: 14 days after the list's end.
    expect(staleMacroReleasesNotice(floor, Date.parse("2026-10-16T02:00:00Z"))).toBeNull();
    expect(staleMacroReleasesNotice(floor, Date.parse("2026-10-16T05:00:00Z")))
      .toBe("Release days are listed through 2026-10-01; later sessions are left out.");
  });
});
