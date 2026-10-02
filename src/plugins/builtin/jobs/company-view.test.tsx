import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import type { CloudJobsSummaryPayload } from "../../../api-client/types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { resetJobsCache } from "./client";
import { JobsPane } from "./pane";

const day = (offset: number) => new Date(Date.UTC(2026, 8, 26) - offset * 86_400_000).toISOString().slice(0, 10);
// Thirty daily reads climbing from 2,000 to 2,145 open roles.
const series = Array.from({ length: 30 }, (_, index) => ({ day: day(29 - index), open: 2000 + index * 5, new: 20, closed: 15 }));
const summary: CloudJobsSummaryPayload = {
  status: "ok", ticker: "NVDA", companyName: "NVIDIA Corp",
  coverage: { status: "active", vendor: null, careersUrl: null, lastCollectedAt: null, firstObservedAt: day(29), daysObserved: 30, employeeCount: null },
  openCount: 2145, openPerThousandEmployees: null, new7d: 140, new30d: 600, closed30d: 455,
  change30d: { count: 145, percent: 7.3 }, change90d: null, remoteShare: 0.2, medianAgeDays: 30, series,
  functions: [{ id: "engineering", label: "Engineering", count: 1200, share: 0.56, previous: 1100 }],
  countries: [], seniority: [], tags: [], salary: null,
  recent: Array.from({ length: 12 }, (_, index) => ({
    id: index, title: `Role ${String(index).padStart(2, "0")}`, function: "engineering", seniority: null, location: "Santa Clara, CA",
    country: "US", remote: false, postedAt: day(index), postedPrecision: "exact" as const, firstSeenAt: day(index), url: null,
    salaryMin: null, salaryMax: null, salaryCurrency: null, salaryPeriod: null, tags: [],
  })),
};
const spies = [
  spyOn(apiClient, "getCloudJobs").mockResolvedValue(summary),
  spyOn(apiClient, "getCloudJobsPostings").mockResolvedValue({ postings: [], total: 12 }),
  spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "pro", emailVerified: true, plan: "pro" } as never),
];
afterAll(() => { for (const spy of spies) spy.mockRestore(); });

const tui = createOpenTuiTestHarness();
afterEach(() => {
  resetJobsCache();
});

async function render(width: number, height: number): Promise<string[]> {
  const id = "jobs:NVDA";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-jobs-view", { instanceId: id, paneId: "jobs", binding: { kind: "fixed", symbol: "NVDA" } }));
  state.tickers.set("NVDA", createTestTicker("NVDA", "NVIDIA Corp"));
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [paneState, setPaneState] = useState(state.paneState);
    state.paneState = paneState;
    return <TestPaneFrame width={width} height={height + 1} state={state} dispatch={(action) => setPaneState(appReducer(state, action).paneState)} paneId={id} pluginId="jobs" runtime={runtime}>
      {(body) => <JobsPane width={body.width} height={body.height} focused />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height: height + 1 }); });
  for (let i = 0; i < 8; i += 1) await act(async () => { await Bun.sleep(5); await tui.setup().renderOnce(); });
  return tui.frame().split("\n");
}

test("the open-roles line sits beside the function bars and names what it plots", async () => {
  const lines = await render(108, 32);
  expect(lines[0]).toMatch(/Open roles\s+2,145/);
  // Legend row under the figures: the series and its latest value, the bars' heading beside it.
  const legend = lines.findIndex((line) => line.includes("● Open roles"));
  expect(legend).toBe(2);
  expect(lines[legend]).toMatch(/● Open roles 2,145\s+By Function/);
  // A line on an axis cut to its range, not an area from zero.
  const band = lines.slice(legend + 1, lines.findIndex((line) => line.includes("Roles  Locations")));
  expect(band.some((line) => /2,1\d\d/.test(line))).toBe(true);
  expect(band.join("\n")).not.toMatch(/\b0\s*$/m);
  expect(lines.findIndex((line) => line.includes("Roles  Locations"))).toBeGreaterThan(6);
  // Tabs sit right under the band, with no blank row between.
  const tabs = lines.findIndex((line) => line.includes("Roles  Locations"));
  expect(lines[tabs - 1]!.trim()).not.toBe("");
  expect(lines[tabs + 1]).toContain("ROLE");
});

test("a short pane keeps the roles list: the band becomes a strip, then goes", async () => {
  let lines = await render(60, 12);
  let tabs = lines.findIndex((line) => line.includes("Roles  Locations"));
  // One row of figures, the strip, the tabs, then the roles.
  expect(tabs).toBe(2);
  expect(lines[1]).toMatch(/^ ● [⠀-⣿]/);
  expect(lines.filter((line) => /Role \d\d/.test(line)).length).toBeGreaterThanOrEqual(4);
  await tui.destroy();
  resetJobsCache();

  lines = await render(22, 10);
  tabs = lines.findIndex((line) => line.includes("Roles"));
  expect(lines.join("\n")).not.toContain("●");
  expect(lines.filter((line) => /Role/.test(line)).length).toBeGreaterThanOrEqual(4);
  expect(tabs).toBeLessThanOrEqual(1);
});
