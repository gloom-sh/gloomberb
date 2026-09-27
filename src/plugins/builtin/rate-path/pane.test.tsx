import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { RateMeeting, RatePathPayload } from "../../../api-client/rates";
import { testRender } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
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
    dotPlot: { asOf: "2026-09-16", sourceUrl: "https://www.federalreserve.gov", points: [] },
    schedule: { sourceUrl: "https://www.federalreserve.gov", verifiedAt: "2026-09-22", through: "2027-12-08" },
    probabilityAssumption: "Two outcomes", slope: { valueBps: -70, percentile: 20, samples: 250, asOf: "2026-09-22T14:00:00Z" }, gaps: [] };
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let spy: { mockRestore(): void } | undefined;
afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  spy?.mockRestore(); spy = undefined;
});

async function render(width: number, height: number): Promise<string[]> {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-rate-path-test", { instanceId: "wirp", paneId: "rate-path", binding: { kind: "none" } }));
  state.focusedPaneId = "wirp";
  await act(async () => { setup = await testRender(<TestPaneFrame state={state} paneId="wirp" pluginId="rate-path" runtime={createTestPluginRuntime()} width={width} height={height}>
    {(body) => <RatePathPane paneId="wirp" paneType="rate-path" focused {...body} />}
  </TestPaneFrame>, { width, height }); });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await setup!.renderOnce(); });
  return setup!.captureCharFrame().split("\n");
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
