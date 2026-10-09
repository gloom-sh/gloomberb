import { describe, expect, test } from "bun:test";
import type { HeadlessPaneDefinition, HeadlessPaneResult } from "../../types/plugin";
import { deriveHeadlessFreshness, formatFreshnessLine } from "./freshness";

const NOW = Date.parse("2026-10-09T05:00:00Z"); // Friday, before the US open
const rows = (freshness?: HeadlessPaneDefinition["freshness"]) => ({ shape: "rows" as const, ...(freshness ? { freshness } : {}) });
const line = (definition: Pick<HeadlessPaneDefinition, "shape" | "freshness">, result: HeadlessPaneResult) => (
  formatFreshnessLine(deriveHeadlessFreshness(definition, result, NOW))
);

describe("report freshness", () => {
  test("is live only when the data says so, and the worst row decides", () => {
    const live = { dataSource: "live", lastUpdated: NOW - 60_000 };
    expect(line(rows(), { rows: [live, live] }))
      .toBe("Source: Gloom Cloud | As of 2026-10-09 04:59 UTC | Live");
    expect(line(rows(), { rows: [live, { dataSource: "delayed", delayMinutes: 15, lastUpdated: NOW - 20 * 60_000 }] }))
      .toBe("Source: Gloom Cloud | As of 2026-10-09 04:59 UTC | Delayed 15 min");
    // A dated row with no feed signal is not called live.
    expect(line(rows(), { rows: [{ price: 1, lastUpdated: NOW - 60_000 }] }))
      .toBe("Source: Gloom Cloud | As of 2026-10-09 04:59 UTC | Status not reported");
  });

  test("a partly stale board names the share; a wholly stale one says how old it is", () => {
    const fresh = { delayMinutes: 10, stale: false, asOf: "2026-10-09T04:50:00Z" };
    const old = { delayMinutes: 10, stale: true, asOf: "2026-09-15T16:40:00Z" };
    const partly = deriveHeadlessFreshness(rows(), { rows: [fresh, fresh, old], metadata: { stale: true } }, NOW);
    expect(partly).toMatchObject({ status: "stale", feed: "delayed", delayMinutes: 10, staleCount: 1, observationCount: 3, oldest: "2026-09-15T16:40:00.000Z" });
    expect(formatFreshnessLine(partly))
      .toBe("Source: Gloom Cloud | As of 2026-10-09 04:50 UTC (oldest 2026-09-15) | Delayed 10 min, 1 of 3 stale");
    expect(line(rows({ status: "delayed", maxAgeMinutes: 60 }), { rows: [{ quoteTime: "2026-10-09T02:00:00Z" }] }))
      .toBe("Source: Gloom Cloud | As of 2026-10-09 02:00 UTC | Stale (3 hours old)");
  });

  test("filed data is never stale for its age, only for a release it missed", () => {
    const filings = rows({ source: "SEC EDGAR", status: "not-a-feed", basis: "filed data", observedKey: "filedAt", oldest: null });
    expect(line(filings, { rows: [{ filedAt: "2025-02-01" }, { filedAt: "2019-03-01" }] }))
      .toBe("Source: SEC EDGAR | As of 2025-02-01 | Not a live feed (filed data)");
    const release = { source: "BLS", status: "not-a-feed" as const, basis: "monthly release", asOf: "2026-09-11T12:30:00Z" };
    expect(line(rows(), { rows: [], freshness: { ...release, nextExpectedAt: "2026-10-14T12:30:00Z" } }))
      .toBe("Source: BLS | As of 2026-09-11 12:30 UTC | Not a live feed (monthly release)");
    expect(line(rows(), { rows: [], freshness: { ...release, nextExpectedAt: "2026-10-07T12:30:00Z" } }))
      .toBe("Source: BLS | As of 2026-09-11 12:30 UTC | Stale (27 days old)");
  });

  test("a daily series may lag one completed session and no more", () => {
    const daily = { shape: "series" as const, freshness: { status: "not-a-feed" as const, basis: "daily closes", cadence: "daily" as const } };
    const series = (date: string) => ({ series: [{ id: "spy", label: "SPY", points: [{ date, close: 1 }] }] });
    // Before Friday's open, Thursday's close is current and Wednesday's is a day behind.
    expect(deriveHeadlessFreshness(daily, series("2026-10-07T00:00:00Z"), NOW).status).toBe("not-a-feed");
    expect(deriveHeadlessFreshness(daily, series("2026-10-06T00:00:00Z"), NOW)).toMatchObject({ status: "stale", asOf: "2026-10-06T00:00:00.000Z" });
  });

  test("without a dated observation it cites the retrieval time instead of inventing an as-of", () => {
    expect(line(rows({ source: "Your inputs", status: "not-a-feed", basis: "calculator" }), { rows: [{ value: 1 }] }))
      .toBe("Source: Your inputs | Retrieved 2026-10-09 05:00 UTC | Not a live feed (calculator)");
  });

  test("prints the same UTC times whatever the host's zone", async () => {
    const script = `
      import { serializeCliResult } from "./src/cli/result";
      import { DEFAULT_CLI_OPTIONS } from "./src/cli/options";
      import { formatFreshnessLine, deriveHeadlessFreshness } from "./src/cli/pane-functions/freshness";
      const data = [{ updatedAt: "2026-10-08T23:59:00Z", publishedAt: new Date(Date.UTC(2026, 9, 7, 11, 27)), lastUpdated: 1791503940000 }];
      console.log(serializeCliResult({ data }, { ...DEFAULT_CLI_OPTIONS, color: false }));
      console.log(formatFreshnessLine(deriveHeadlessFreshness({ shape: "rows" }, { rows: data }, ${NOW})));
    `;
    const run = async (zone: string) => {
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: process.cwd(), env: { ...process.env, TZ: zone, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      expect(exitCode).toBe(0);
      return stdout;
    };
    const [tokyo, losAngeles] = await Promise.all([run("Asia/Tokyo"), run("America/Los_Angeles")]);
    expect(tokyo).toBe(losAngeles);
    expect(tokyo).toContain("2026-10-08 23:59 UTC");
    expect(tokyo).toContain("2026-10-07 11:27 UTC");
    expect(tokyo).toContain("As of 2026-10-08 23:59 UTC");
  });
});
