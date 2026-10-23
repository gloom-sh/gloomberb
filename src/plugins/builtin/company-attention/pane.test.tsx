import { act, useReducer } from "react";
import { afterEach, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, createTestTicker, TestPaneProvider } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { attentionCache } from "./client";
import { HiringPane } from "./pane";
import { AppRankView } from "./app-rank";
import realHiring from "./fixtures/hiring.json";
import realAppRank from "./fixtures/app-rank.json";

const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); attentionCache.reset(); });
async function mount(tab: string, onNavigate: (id: string, symbol?: string | null) => void, snapshot = true) {
  const id = "hiring:test";
  const state = createInitialState(createTestPaneConfig("/tmp/hiring-pane-test", { paneId: "hiring", instanceId: id, binding: { kind: "fixed", symbol: "ADYEN:AMS" }, settings: { tab, ...(snapshot ? { attentionSnapshot: realHiring } : {}) } }));
  state.tickers.set("ADYEN:AMS", createTestTicker("ADYEN:AMS", "Adyen"));
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime({ createPaneFromTemplate: (template, options) => onNavigate(template, options?.symbol),
      pinTicker: (symbol, options) => onNavigate(options?.paneType ?? "", symbol) })}>
      <PaneFooterProvider>{(footer) => <Box width={100} height={22} flexDirection="column"><Box height={21}><HiringPane width={100} height={21} focused /></Box><PaneFooterBar footer={footer} width={100} focused /><PaneFooterKeys paneId={id} footer={footer} focused /></Box>}</PaneFooterProvider>
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 22 }); });
}
test("evidence opens in the stack, keeps original title, and DES preserves the non-US exchange", async () => {
  const navigations: Array<[string, string | null | undefined]> = [];
  await mount("evidence", (id, symbol) => navigations.push([id, symbol]));
  await tui.waitForFrameToContain("SENIORITY");
  await tui.emitKeypress({ name: "return" });
  const frame = await tui.waitForFrameToContain("Place");
  expect(frame).toContain("Paris");
  expect(frame).toContain("Oct 3, 2026");
  for (const field of ["Reporting ticker", "Revision", "Confidence", "Unknown", "--", "2026-10-03T"]) expect(frame).not.toContain(field);
  await tui.emitKeypress({ name: "escape" });
  await tui.waitForFrameToContain("SENIORITY");
  await tui.emitKeypress({ name: "d" });
  expect(navigations).toEqual([["ticker-research", "ADYEN:AMS"]]);
});

test("a posting's detail reads its page: date, pay, hours and description", async () => {
  const requests: string[] = [];
  setCloudApiFetchTransport(async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/cloud/jobs/")) return Response.json({ ...realHiring.evidence[0], id: 1, externalId: "7586281", title: "Account Manager", function: "sales", location: "Paris, FR", country: "FR", postedAt: "2026-09-29", postedPrecision: "exact",
      firstSeenAt: "2026-09-30T00:00:00Z", salaryMin: 60000, salaryMax: 70000, salaryCurrency: "EUR", salaryPeriod: "year", employmentType: "FULL_TIME", description: "Grow Adyen's merchants in France.", closedAt: null, employmentKind: null });
    return Response.json(realHiring);
  });
  await mount("evidence", () => {}, false);
  await tui.waitForFrameToContain("SENIORITY");
  await tui.emitKeypress({ name: "return" });
  const frame = await tui.waitForFrameToContain("Grow Adyen's merchants");
  expect(frame).toContain("Sep 29, 2026");
  expect(frame).toContain("€60k–70k");
  expect(frame).toContain("Full time");
  expect(frame).toContain("Paris, France");
  expect(requests.some((url) => url.includes("/cloud/jobs/ADYEN%3AAMS/posting?externalId=7586281") || url.includes("/cloud/jobs/ADYEN:AMS/posting?externalId=7586281"))).toBe(true);
});

test("individual app history opens with the requested window", async () => {
  const id = "apps:window:test";
  const state = createInitialState(createTestPaneConfig("/tmp/apps-window-test", { paneId: "apps", instanceId: id, settings: { days: "365", appRankSnapshot: realAppRank } }));
  const focus = { store: "app-store" as const, appId: "6446901002", name: "Threads", country: "US", chart: "free" as const };
  function Harness() {
    const [current, dispatch] = useReducer(appReducer, state);
    return <TestPaneProvider state={current} dispatch={dispatch} paneId={id} pluginId="ticker-research" runtime={createTestPluginRuntime()}>
      <AppRankView focus={focus} accessKey="window-test" width={100} height={22} focused />
    </TestPaneProvider>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 22 }); });
  expect(await tui.waitForFrameToContain("365D")).toContain("US");
});
