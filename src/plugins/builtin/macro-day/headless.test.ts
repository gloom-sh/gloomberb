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
