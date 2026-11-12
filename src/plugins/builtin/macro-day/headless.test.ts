import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient, type CloudMacroReleaseDaysPayload } from "../../../api-client";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import type { HeadlessPaneContext } from "../../../types/headless";
import { macroReleaseCache } from "./client";
import { macroDayHeadless } from "./headless";

afterEach(() => {
  macroReleaseCache.reset();
  setSystemTime();
});

test("an FOMC day's row is named FOMC, its decision a field of its own, and the text reads them together", async () => {
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  const days: CloudMacroReleaseDaysPayload = {
    checkedAt: "2026-11-06T22:00:00Z", coveredThrough: "2026-11-06", sources: [], figuresFrom: "2026-01-02",
    releases: { cpi: [], jobs: [], fomc: ["2026-10-28"] },
    figures: { fomc: { "2026-10-28": { event: "Federal funds target range", actual: "3.75-4.00%", forecast: "3.75-4.00%",
      prior: "3.75-4.00%", surprise: "in-line", decision: "held" } } },
  };
  spyOn(apiClient, "getCloudMacroReleaseDays").mockResolvedValue(days);
  // FRED:T10Y2Y, a spread, from 1 Oct: one release day among a month of quiet ones.
  const observations = Array.from({ length: 37 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 1 + index)).toISOString().slice(0, 10);
    return { date, value: 0.5 + (date === "2026-10-28" ? 0.04 : 0) + (index % 3) / 1000 };
  });
  const fred = { getCloudFredSeries: async () => ({ observations, fetchedAt: "2026-11-06T22:00:00Z" }) };
  const args = { rawArgument: "FRED:T10Y2Y", argument: "FRED:T10Y2Y", symbols: ["FRED:T10Y2Y"], options: { release: "fomc" } };
  const result = await macroDayHeadless.load!(args, { apiClient: fred, signal: new AbortController().signal } as unknown as HeadlessPaneContext);

  if (!result) throw new Error("MDAY loaded nothing");
  const section = result.sections.find((entry) => "title" in entry && entry.title === "Release days");
  const day = section && "rows" in section ? section.rows?.[0] : undefined;
  expect(day).toMatchObject({ date: "2026-10-28", event: "FOMC", decision: "held", actual: "3.75-4.00%" });
  const text = renderHeadlessPaneText(macroDayHeadless, result, args, "MDAY", deriveHeadlessFreshness(macroDayHeadless, result, Date.now()));
  expect(text).toMatch(/2026-10-28\s+FOMC held\s+3\.75-4\.00%/);
});

test("an ECB day before the economic calendar has its rates and lacks only the forecast, and the note says that, not that it has nothing", async () => {
  setSystemTime(new Date("2026-11-07T12:00:00Z"));
  const held = (rate: string, forecast: string | null) => ({ event: "Deposit facility rate", actual: rate, forecast, prior: rate,
    surprise: forecast ? "in-line" as const : null, decision: "held" });
  const days: CloudMacroReleaseDaysPayload = {
    checkedAt: "2026-11-06T22:00:00Z", coveredThrough: "2026-11-06", sources: [], figuresFrom: "2026-01-01",
    releases: { cpi: [], jobs: [], fomc: [], ecb: ["2025-10-30", "2025-12-18", "2026-10-29"] },
    figures: { ecb: { "2025-10-30": held("2.00%", null), "2025-12-18": held("2.00%", null), "2026-10-29": held("2.50%", "2.50%") } },
  };
  spyOn(apiClient, "getCloudMacroReleaseDays").mockResolvedValue(days);
  const observations = Array.from({ length: 432 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 8, 1 + index)).toISOString().slice(0, 10);
    return { date, value: 0.5 + (index % 5) / 1000 };
  });
  const fred = { getCloudFredSeries: async () => ({ observations, fetchedAt: "2026-11-06T22:00:00Z" }) };
  const load = async (release: string) => {
    const args = { rawArgument: "FRED:T10Y2Y", argument: "FRED:T10Y2Y", symbols: ["FRED:T10Y2Y"], options: { release } };
    const result = await macroDayHeadless.load!(args, { apiClient: fred, signal: new AbortController().signal } as unknown as HeadlessPaneContext);
    if (!result) throw new Error("MDAY loaded nothing");
    return { notes: result.notes ?? [], text: renderHeadlessPaneText(macroDayHeadless, result, args, "MDAY", deriveHeadlessFreshness(macroDayHeadless, result, Date.now())) };
  };
  const ecb = await load("ecb");
  expect(ecb.text).toMatch(/2025-10-30\s+ECB held\s+2\.00%/);
  expect(ecb.notes).toContain("Forecasts start 2026-01-01, with Gloom Cloud's economic calendar: ECB days before it have an actual and prior, no forecast or surprise.");
  expect(ecb.notes.some((note) => note.includes("have no actual, forecast or prior"))).toBe(false);
  // A US day before the calendar has no figures at all, and is named by its kind.
  const cpi = await load("cpi");
  expect(cpi.notes).toContain("CPI days before 2026-01-01 have no actual, forecast or prior: Gloom Cloud's economic calendar starts then.");
});
