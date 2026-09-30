import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { RateMeeting, RatePathPayload } from "../../../api-client/rates";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { ratePathCache } from "./client";
import { RatePathPane } from "./pane";

const DATES = ["2026-10-28", "2026-12-09", "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15"];
function payload(): RatePathPayload {
  const metric = { value: 4, asOf: "2026-09-21", percentile: 50, samples: 250, source: "fred" as const };
  const meetings: RateMeeting[] = DATES.map((date, index) => ({ date, impliedRate: 3.9 - index * 0.1, targetMidpoint: 3.875,
    changeBps: -10 * (index + 1), percentile: 25, samples: 220, asOf: "2026-09-22T14:00:00Z",
    probabilities: [{ targetMidpoint: 3.75, probability: 0.5 }, { targetMidpoint: 4, probability: 0.5 }], method: "following-month", reason: null }));
  return { asOf: "2026-09-22T14:00:00Z", fetchedAt: "2026-09-22T14:01:00Z", stale: false, status: "available",
    current: { effr: metric, targetLower: { ...metric, value: 3.75 }, targetUpper: metric }, meetings, fedFunds: [], sofr: [],
    ghosts: [{ label: "1W", requestedDate: "2026-09-15", asOf: "2026-09-15", points: DATES.map((date, index) => ({ date, impliedRate: 4 - index * 0.08 })) }],
    dotPlot: { asOf: "2026-09-16", sourceUrl: "https://www.federalreserve.gov", points: [{ year: 2026, rate: 3.6 }] },
    schedule: { sourceUrl: "https://www.federalreserve.gov", verifiedAt: "2026-09-22", through: "2027-12-08" },
    probabilityAssumption: "Two outcomes", slope: { valueBps: -70, percentile: 20, samples: 250, asOf: "2026-09-22T14:00:00Z" }, gaps: [] };
}

const tui = createOpenTuiTestHarness();
let spy: { mockRestore(): void } | undefined;
afterEach(() => {
  spy?.mockRestore(); spy = undefined;
  ratePathCache.reset();
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
}

async function render(width: number, height: number): Promise<string[]> {
  await tui.destroy();
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-rate-path-test", { instanceId: "wirp", paneId: "rate-path", binding: { kind: "none" } }));
  initial.focusedPaneId = "wirp";
  function Harness() {
    // The selected meeting is pane state, so moving it needs a reducer.
    const [state, setState] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setState((current) => appReducer(current, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="wirp" pluginId="rate-path" runtime={createTestPluginRuntime()} width={width} height={height}>
      {(body) => <RatePathPane paneId="wirp" paneType="rate-path" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
  await settle();
  return tui.frame().split("\n");
}

test("the path fits the body: short panes give the meetings the room instead of a second curve table", async () => {
  spy = spyOn(apiClient, "getCloudRatePath").mockResolvedValue(payload());
  for (const [width, height] of [[40, 10], [60, 16]] as const) {
    const lines = await render(width, height);
    const frame = lines.join("\n");
    expect(frame).not.toContain("TENOR");
    expect(frame).toContain("MEETING");
    expect(frame).toContain("2026-10-28");
    expect(lines.findIndex((line) => line.includes("as of 2026-09-22 14:00 UTC"))).toBe(height - 1);
  }
  // With room the chart draws above the meetings, and the last meeting sits on the footer.
  const lines = await render(84, 29);
  expect(lines.join("\n")).toContain("Implied EFFR");
  expect(lines.join("\n")).not.toContain("TENOR");
  expect(lines[27]).toContain("2027-09-15");
});

test("the path names what it plots: one target range, the SEP dots, meetings by month", async () => {
  spy = spyOn(apiClient, "getCloudRatePath").mockResolvedValue(payload());
  const lines = await render(140, 45);
  const header = lines.findIndex((line) => line.includes("MEETING"));
  const legend = lines.slice(0, header).find((line) => line.includes("Implied EFFR % by FOMC meeting"));
  expect(legend).toBeDefined();
  // The floor and the ceiling draw one band, named once.
  expect(legend!.split("Target range")).toHaveLength(2);
  expect(legend).not.toContain("Target floor");
  expect(legend).toContain("● EFFR");
  expect(legend).toContain("● SEP median");
  expect(legend).toContain("● 1W ago");
  // The axis and the readout name meetings by month and year, and moves read in bp like VS NOW.
  expect(lines.slice(0, header).some((line) => line.includes("Oct '26") && line.includes("Jan '27"))).toBe(true);
  expect(lines.join("\n")).toContain("Oct '26 3.90%  1W ago -10.0bp");
  expect(lines.slice(0, header).join("\n")).not.toContain("10-28");
  // Every meeting shares its rank and quote time, so neither is a column.
  expect(lines[header]).not.toContain("PCTL");
  expect(lines[header]).not.toContain("AS OF");
});

test("the selected meeting is the path's point", async () => {
  spy = spyOn(apiClient, "getCloudRatePath").mockResolvedValue(payload());
  await render(86, 30);
  expect(tui.frame()).toContain("Oct '26 3.90%");
  await act(async () => { tui.setup().mockInput.pressArrow("down"); await tui.setup().renderOnce(); });
  await settle();
  const frame = tui.frame();
  expect(frame).toContain("Dec '26 3.80%  1W ago -12.0bp");
  expect(frame).not.toContain("Oct '26 3.90%");
});

test("a short pane keeps its meetings: the path becomes a strip, then goes", async () => {
  spy = spyOn(apiClient, "getCloudRatePath").mockResolvedValue(payload());
  let lines = await render(40, 10);
  let header = lines.findIndex((line) => line.includes("MEETING"));
  expect(lines[header - 1]).toContain("● Implied EFFR");
  expect(lines[header - 1]).toContain("Oct '26 3.90%");
  expect(lines.slice(header + 1).filter((line) => /20\d\d-\d\d-\d\d/.test(line)).length).toBeGreaterThanOrEqual(4);
  lines = await render(22, 10);
  header = lines.findIndex((line) => line.includes("MEETING"));
  expect(lines.join("\n")).not.toContain("●");
  expect(lines.slice(header + 1).filter((line) => /20\d\d-\d\d-\d\d/.test(line)).length).toBeGreaterThanOrEqual(4);
});

test("meetings that differ keep their rank and quote time", async () => {
  const data = payload();
  data.meetings[1] = { ...data.meetings[1]!, percentile: 80, asOf: "2026-09-22T13:00:00Z" };
  spy = spyOn(apiClient, "getCloudRatePath").mockResolvedValue(data);
  const lines = await render(100, 30);
  const header = lines.find((line) => line.includes("MEETING"));
  expect(header).toContain("PCTL 1Y");
  expect(header).toContain("AS OF UTC");
});

test("the first screen leads with the next meeting's odds and prices every meeting in moves", async () => {
  spy = spyOn(apiClient, "getCloudRatePath").mockResolvedValue(payload());
  const lines = await render(120, 40);
  const frame = lines.join("\n");
  // Every meeting prices 10bp more cutting than the one before: 40% odds of a cut at each.
  expect(frame).toMatch(/Next FOMC +40% cut +Oct 28 · /);
  expect(frame).toMatch(/Oct '26 to Sep '27 +-70\.0bp +20 pctl 1Y/);
  expect(frame).not.toContain("Last-first");
  const header = lines.findIndex((line) => line.includes("MEETING"));
  expect(lines[header]).toMatch(/MEETING.*MOVES +P\(MOVE\) +VS NOW +EFFR/);
  expect(lines[header + 1]).toMatch(/2026-10-28 +-0\.40 +40% cut +-10\.0bp +3\.90%/);
  expect(lines[header + 8]).toMatch(/2027-09-15 +-3\.20 +40% cut +-80\.0bp +3\.20%/);
});
