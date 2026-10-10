import { describe, expect, test } from "bun:test";
import type { HeadlessPaneDefinition, HeadlessPaneResult } from "../../types/plugin";
import { cloudNewsFreshness } from "../../plugins/builtin/shared/report-freshness";
import { delayLength, deriveHeadlessFreshness, formatFreshnessLine, formatStatusLine, statusLineVariants } from "./freshness";

const NOW = Date.parse("2026-10-09T05:00:00Z"); // Friday, before the US open
const rows = (freshness?: HeadlessPaneDefinition["freshness"]) => ({ shape: "rows" as const, ...(freshness ? { freshness } : {}) });
const line = (definition: Pick<HeadlessPaneDefinition, "shape" | "freshness">, result: HeadlessPaneResult) => (
  formatFreshnessLine(deriveHeadlessFreshness(definition, result, NOW))
);

describe("report freshness", () => {
  test("says how long a delay is in minutes or hours, as a range when rows differ", () => {
    expect([15, 20, 60, 90, 720, 3 * 24 * 60].map(delayLength)).toEqual(["15 min", "20 min", "1 h", "90 min", "12 h", "3 days"]);
    const delayed = (delayMinutes: number) => ({ dataSource: "delayed", delayMinutes, lastUpdated: NOW - 20 * 60_000 });
    expect(line(rows(), { rows: [delayed(15), delayed(20)] })).toBe("Source: Gloom Cloud · Fri 9 Oct 04:40 UTC · 15-20 min delayed");
    // News held back for an account without real-time access says how far; with it, the wire is live.
    const stories = { rows: [{ publishedAt: "2026-10-08T16:30:00Z" }, { publishedAt: "2026-10-08T15:00:00Z" }] };
    expect(line(rows(cloudNewsFreshness(false)), stories)).toBe("Source: Gloom Cloud · Thu 8 Oct 16:30 UTC · 12 h delayed");
    expect(line(rows(cloudNewsFreshness(true)), stories)).toBe("Source: Gloom Cloud · Thu 8 Oct 16:30 UTC · live");
    expect(line(rows(), { rows: [{ dataSource: "delayed", lastUpdated: NOW - 60_000 }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 04:59 UTC · delayed");
  });

  test("a narrow capture keeps the date and the delay, shortening the rest first", () => {
    const freshness = deriveHeadlessFreshness(rows(), { rows: [
      { dataSource: "delayed", delayMinutes: 15, stale: false, sessionExchange: "NASDAQ", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T23:59:00Z") },
      { dataSource: "delayed", delayMinutes: 20, stale: true, sessionExchange: "ASX", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-07T05:10:00Z") },
    ] }, Date.parse("2026-10-10T13:00:00Z"));
    expect(formatStatusLine(freshness))
      .toBe("Fri 9 Oct close (oldest Wed 7 Oct) · 15-20 min delayed, 1 of 2 stale · markets closed until Mon");
    expect(statusLineVariants(freshness)).toEqual([
      "Fri 9 Oct close (oldest Wed 7 Oct) · 15-20 min delayed, 1 of 2 stale · markets closed until Mon",
      "Fri 9 Oct close (oldest Wed 7 Oct) · 15-20 min delayed, 1 of 2 stale · reopens Mon",
      "Fri 9 Oct close · 15-20 min delayed, 1 of 2 stale · reopens Mon",
      "Fri 9 Oct close · 15-20 min delayed, 1 stale · reopens Mon",
      "Fri 9 Oct close · 15-20 min delayed, 1 stale",
    ]);
  });

  test("is live only when the data says so, and the worst row decides", () => {
    const live = { dataSource: "live", lastUpdated: NOW - 60_000 };
    expect(line(rows(), { rows: [live, live] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 04:59 UTC · live");
    expect(line(rows(), { rows: [live, { dataSource: "delayed", delayMinutes: 15, lastUpdated: NOW - 20 * 60_000 }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 04:59 UTC · 15 min delayed");
    // A dated row with no feed signal is not called live.
    expect(line(rows(), { rows: [{ price: 1, lastUpdated: NOW - 60_000 }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 04:59 UTC · status not reported");
  });

  test("a partly stale board names the share; a wholly stale one says how old it is", () => {
    const fresh = { delayMinutes: 10, stale: false, asOf: "2026-10-09T04:50:00Z" };
    const old = { delayMinutes: 10, stale: true, asOf: "2026-09-15T16:40:00Z" };
    const partly = deriveHeadlessFreshness(rows(), { rows: [fresh, fresh, old], metadata: { stale: true } }, NOW);
    expect(partly).toMatchObject({ status: "stale", feed: "delayed", delayMinutes: 10, staleCount: 1, observationCount: 3, oldest: "2026-09-15T16:40:00.000Z" });
    expect(formatFreshnessLine(partly))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 04:50 UTC (oldest Tue 15 Sep) · 10 min delayed, 1 of 3 stale");
    expect(line(rows({ status: "delayed", maxAgeMinutes: 60 }), { rows: [{ quoteTime: "2026-10-09T02:00:00Z" }] }))
      .toBe("Source: Gloom Cloud · Fri 9 Oct 02:00 UTC · stale (3 hours old)");
  });

  test("filed data is never stale for its age, only for a release it missed", () => {
    const filings = rows({ source: "SEC EDGAR", status: "not-a-feed", basis: "filed data", observedKey: "filedAt", oldest: null });
    expect(line(filings, { rows: [{ filedAt: "2025-02-01" }, { filedAt: "2019-03-01" }] }))
      .toBe("Source: SEC EDGAR · Sat 1 Feb 2025 · not a live feed (filed data)");
    const release = { source: "BLS", status: "not-a-feed" as const, basis: "monthly release", asOf: "2026-09-11T12:30:00Z" };
    expect(line(rows(), { rows: [], freshness: { ...release, nextExpectedAt: "2026-10-14T12:30:00Z" } }))
      .toBe("Source: BLS · Fri 11 Sep 12:30 UTC · not a live feed (monthly release)");
    expect(line(rows(), { rows: [], freshness: { ...release, nextExpectedAt: "2026-10-07T12:30:00Z" } }))
      .toBe("Source: BLS · Fri 11 Sep 12:30 UTC · stale (27 days old)");
  });

  test("published-data metadata flags apply only without row flags and can be ignored", () => {
    const definition = rows({ status: "not-a-feed", basis: "published data" });
    const old = { observedAt: "2020-01-01" };
    const resolve = (data: HeadlessPaneResult, ignoreStaleFlags = false) => deriveHeadlessFreshness(
      { ...definition, freshness: { ...definition.freshness, ignoreStaleFlags } }, data, NOW,
    );
    expect(resolve({ rows: [old] }).status).toBe("not-a-feed");
    expect(resolve({ rows: [old], metadata: { stale: true } }).status).toBe("stale");
    expect(resolve({ rows: [old], metadata: { stale: true } }, true).status).toBe("not-a-feed");
    expect(resolve({ rows: [{ ...old, stale: false }], metadata: { stale: true } }).status).toBe("not-a-feed");
    expect(resolve({ rows: [{ ...old, stale: true }], metadata: { stale: false } }).status).toBe("stale");
    expect(resolve({ rows: [{ ...old, stale: true }, { ...old, stale: false }], metadata: { stale: true } }))
      .toMatchObject({ status: "stale", staleCount: 1, observationCount: 2 });
    expect(resolve({ rows: [{ ...old, stale: true }], metadata: { stale: true } }, true).status).toBe("not-a-feed");
  });

  test("canonical timestamps are observations and future declarations are not", () => {
    const timestamp = "2026-10-09T00:00:00Z";
    for (const value of [timestamp, Date.parse(timestamp), new Date(timestamp)]) {
      expect(deriveHeadlessFreshness(rows(), { rows: [{ timestamp: value }] }, NOW).asOf).toBe("2026-10-09T00:00:00.000Z");
      expect(deriveHeadlessFreshness(rows(), { rows: [], metadata: { timestamp: value } }, NOW).asOf).toBe("2026-10-09T00:00:00.000Z");
    }
    expect(deriveHeadlessFreshness(rows({ asOf: "2027-01-01", nextExpectedAt: "2027-01-01" }), { rows: [{ timestamp }] }, NOW).asOf)
      .toBe("2026-10-09T00:00:00.000Z");
    expect(deriveHeadlessFreshness(rows({ asOf: "2027-01-01" }), { rows: [] }, NOW).asOf).toBeNull();
    expect(deriveHeadlessFreshness(rows({ asOf: NOW + 60_000 }), { rows: [] }, NOW).asOf).toBe("2026-10-09T05:01:00.000Z");
  });

  test("receipt and refresh timestamps cannot supersede a price observation", () => {
    const quoteTime = "2026-10-09T02:00:00Z";
    const result = { rows: [{ quoteTime, updatedAt: NOW, receivedAt: NOW, generatedAt: NOW }],
      metadata: { updatedAt: NOW, receivedAt: NOW, generatedAt: NOW } };
    expect(deriveHeadlessFreshness(rows({ status: "delayed", maxAgeMinutes: 60 }), result, NOW))
      .toMatchObject({ asOf: "2026-10-09T02:00:00.000Z", status: "stale", ageMinutes: 180 });
    expect(deriveHeadlessFreshness(rows(), { rows: [{ lastUpdated: Date.parse(quoteTime), receivedAt: NOW }], metadata: { generatedAt: NOW } }, NOW).asOf)
      .toBe("2026-10-09T02:00:00.000Z");
    expect(deriveHeadlessFreshness(rows(), { rows: [{ receivedAt: NOW }], metadata: { generatedAt: NOW } }, NOW).asOf).toBeNull();
    // CRYP's summary as-of is the newest asset quote, not generatedAt; keep genuine summaries.
    expect(deriveHeadlessFreshness(rows(), { rows: [{ quoteTime }], metadata: { asOf: "2026-10-09T03:00:00Z", generatedAt: NOW } }, NOW).asOf)
      .toBe("2026-10-09T03:00:00.000Z");
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
      .toBe("Source: Your inputs · retrieved Fri 9 Oct 05:00 UTC · not a live feed (calculator)");
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
    expect(tokyo).toContain("Thu 8 Oct 23:59 UTC");
  });
});
