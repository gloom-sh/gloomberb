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

    // Older, malformed or missing lists leave the floor as it is.
    for (const payload of [served("2026-10-01", { jobs: ["2026-10-02"] }), served("2026-10-09", { jobs: ["10/02/2026"] }),
      { coveredThrough: "2026-10-09", releases: { cpi: [], jobs: ["2026-10-02"] } }, null]) {
      expect(mergeMacroReleases(floor, payload)).toBe(floor);
    }
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
