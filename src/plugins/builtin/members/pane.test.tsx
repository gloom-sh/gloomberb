import { afterEach, expect, setSystemTime, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { PaneFooterSegment } from "../../../components";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PluginRuntimeAccess } from "../../../plugins/runtime";
import type { ContextMenuActionItem, ContextMenuItem } from "../../../types/context-menu";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { MEMBER_DESTINATIONS } from "../shared/members-menu";
import { fundBreadthCache, fundChangesCache, fundListCache, fundMembersCache } from "./client";
import { MembersPane } from "./pane";
import { board, changes, member } from "./test-fixture";
const tui = createOpenTuiTestHarness();
afterEach(() => { setSystemTime(); setCloudApiFetchTransport(null); setSharedRegistryForTests(undefined); fundBreadthCache.reset(); fundMembersCache.reset(); fundChangesCache.reset(); fundListCache.reset(); });
const covered = { funds: ["IVV", "IJH", "IJR", "IWM", "IWB"].map((ticker) => ({ ticker, name: ticker, aliases: ticker === "IVV" ? ["SPY", "SPX"] : [], changes: "none" as const, asOf: "2026-10-05" })) };
async function mountMembers(symbol: string, { pins = [], runtime = {}, onMenu, onFooter }: { pins?: string[]; runtime?: Partial<PluginRuntimeAccess>; onMenu?: (menu: ContextMenuItem[]) => void; onFooter?: (info: PaneFooterSegment[]) => void } = {}) {
  for (const cache of [fundBreadthCache, fundMembersCache, fundChangesCache, fundListCache]) cache.attach(new MemoryPluginPersistence());
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: "members", paneId: "members", binding: { kind: "fixed", symbol }, settings: {} }));
  const pluginRuntime = createTestPluginRuntime({ getMarketData: () => null, pinTicker: (symbol) => { pins.push(symbol); }, ...runtime });
  function Harness() {
    const [state, setState] = useState(initial);
    // Stable like the app's: a focused search field re-captures input on a new dispatch and would loop.
    const dispatch = useCallback((action: AppAction) => setState((previous) => appReducer(previous, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="members" pluginId="members" width={115} height={22} runtime={pluginRuntime}>
      {(body, footer) => { onMenu?.(footer.menu); onFooter?.(footer.info); return <MembersPane paneId="members" paneType="members" focused {...body} />; }}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 115, height: 22 }); });
}
test("partial holdings keep number columns aligned, open tickers and lazily load the change stack", async () => {
  const calls: string[] = [], pins: string[] = [];
  const unlisted = { ...member("PRIVATE", null, 0), symbol: null, name: "OMNIAB VESTING Prvt" };
  const holdings = { ...board, members: [...board.members, unlisted], aggregate: { ...board.aggregate, total: 4 } };
  const headline = "Freshworks Set to Join S&P SmallCap 600";
  const announcements = { ...changes, changes: [{ ...changes.changes[0]!, headline, reason: headline, added: "FRSH", removed: "BLFS", daysToGo: 1, effectiveDate: "2026-10-08" }] };
  setCloudApiFetchTransport(async (input) => { const path = new URL(String(input)).pathname; calls.push(path); return Response.json(path.endsWith("/changes") ? announcements : path.endsWith("/members") ? covered : holdings); });
  await mountMembers("SPY", { pins });
  let frame = await tui.waitForFrameToContain("Company AAA");
  expect(frame).toContain("1D 2/4");
  expect(calls.some((path) => path.endsWith("/changes"))).toBe(false);
  const lines = frame.split("\n"), a = lines.find((line) => line.includes("Company AAA"))!, b = lines.find((line) => line.includes("Company BBB"))!;
  expect(a.indexOf("+1.23%") + 6).toBe(b.indexOf("-0.27%") + 6);
  await act(async () => tui.setup().mockInput.pressEnter());
  expect(pins).toEqual(["AAA"]);
  await tui.clickFrameText("OMNIAB VESTING Prvt");
  await act(async () => tui.setup().mockInput.pressEnter());
  expect(pins).toEqual(["AAA"]);
  await tui.clickFrameText("Movers");
  await tui.waitForFrameToContain("Detractors");
  await tui.clickFrameText("Changes");
  frame = await tui.waitForFrameToContain("Index replacement");
  expect(frame).not.toContain(headline);
  await act(async () => tui.setup().mockInput.pressEnter());
  frame = await tui.waitForFrameToContain("Estimate from IVV share counts");
  expect(frame).toContain("2026-10-08");
  expect(frame.split(headline)).toHaveLength(2);
});
test("a fund outside the server's covered list says which funds are covered", async () => {
  setCloudApiFetchTransport(async (input) => new URL(String(input)).pathname.endsWith("/members") ? Response.json(covered) : Response.json({ error: "Covered funds" }, { status: 404 }));
  await mountMembers("IBIT");
  const frame = await tui.waitForFrameToContain("IBIT is not a covered fund. Covered: IVV");
  expect(frame).not.toContain("not available on this server");
});
test("Movers has no members menu, and a search narrows what the menu opens", async () => {
  setCloudApiFetchTransport(async (input) => Response.json(new URL(String(input)).pathname.endsWith("/members") ? covered : board));
  setSharedRegistryForTests({ paneTemplates: new Map(MEMBER_DESTINATIONS.map((destination) => [destination.templateId, {}])),
    getPaneTemplatePluginId: () => undefined } as unknown as PluginRegistry);
  const opened: unknown[] = [];
  let menu: ContextMenuItem[] = [];
  const entry = (label: string) => menu.find((item): item is ContextMenuActionItem => item.type !== "divider" && item.type !== "role" && item.label === label);
  await mountMembers("IVV", { runtime: { createPaneFromTemplate: (templateId, options) => { opened.push([templateId, options]); } }, onMenu: (items) => { menu = items; } });
  await tui.waitForFrameToContain("Company AAA");
  await tui.clickFrameText("Movers");
  await tui.waitForFrameToContain("Detractors");
  expect(entry("Open Members In…")).toBeUndefined();
  await tui.clickFrameText("Members");
  await tui.waitForFrameToExclude("Detractors");
  await tui.clickFrameText("ticker, name or sector");
  await act(async () => { await tui.setup().mockInput.typeText("BBB"); });
  await tui.waitForFrameToExclude("Company AAA");
  await act(async () => { await entry("Open Members In…")!.onSelect!(); });
  await tui.waitForFrameToContain("Open IVV members matching \"BBB\" in");
  await act(async () => tui.setup().mockInput.pressEnter());
  expect(opened).toEqual([["relative-rotation-rrg", { symbols: ["BBB"], arg: "BBB" }]]);
});

test("index alias opens Breadth lazily and keeps missing windows distinct from zero", async () => {
  const calls: string[] = [];
  const row = { date: "2026-10-07", asOf: "2026-10-07T22:00:00Z", membershipAsOf: "2026-10-05", memberCount: 3, observed: 2,
    advances: 1, declines: 0, unchanged: 1, advanceDeclineEligible: 2, ma20: { above: 1, eligible: 2, percent: 50 },
    ma50: { above: 0, eligible: 1, percent: 0 }, ma200: { above: 0, eligible: 0, percent: null }, newHighs: 0, newLows: 0, highLowEligible: 0, adLine: 1 };
  setCloudApiFetchTransport(async input => {
    const path = new URL(String(input)).pathname; calls.push(path);
    return Response.json(path.endsWith("/breadth") ? { fund: board.fund, latest: row, history: [row], stale: false, basis: "daily-close", membershipBasis: "current-members" }
      : path.endsWith("/members") ? covered : board);
  });
  await mountMembers("^SPX");
  await tui.waitForFrameToContain("Company AAA");
  expect(calls.some(path => path.endsWith("/breadth"))).toBe(false);
  await tui.clickFrameText("Breadth");
  const frame = await tui.waitForFrameToContain("A/D 2/3");
  expect(calls).toContain("/cloud/members/IVV/breadth");
  expect(frame).toContain("50.0%");
  expect(frame).toContain("0.0%");
  expect(frame).toContain("--");
  await tui.clickFrameText("Members");
  await tui.waitForFrameToContain("Company AAA");
});

// Friday 23 Oct 2026: the regular session closes at 20:00 UTC (16:00 New York).
const FRIDAY_CLOSE = "2026-10-23T20:00:00Z";
const feedCases = [
  { name: "in the regular session a Pro account's footer says live and dates the quotes", now: "2026-10-23T15:00:00Z", access: "realtime", dailyAsOf: "2026-10-23T15:00:00Z", has: ["live", "2026-10-23"], hasNot: ["close"] },
  { name: "after the close it names the close, not live, and does not say the date twice", now: "2026-10-23T21:30:00Z", access: "realtime", dailyAsOf: FRIDAY_CLOSE, has: ["Fri 23 Oct close"], hasNot: ["live", "2026-10-23"] },
  { name: "on a weekend it still names Friday's close", now: "2026-10-24T14:00:00Z", access: "realtime", dailyAsOf: FRIDAY_CLOSE, has: ["Fri 23 Oct close"], hasNot: ["live", "2026-10-23"] },
  { name: "figures dated another day than the close keep their date beside it", now: "2026-10-24T14:00:00Z", access: "realtime", dailyAsOf: "2026-10-22T20:00:00Z", has: ["Fri 23 Oct close", "2026-10-22"], hasNot: ["live"] },
  { name: "a delayed account's footer is the delay and the quotes' date, in or out of a session", now: "2026-10-24T14:00:00Z", access: "delayed", dailyAsOf: FRIDAY_CLOSE, has: ["◷15m", "2026-10-23"], hasNot: ["live", "close"] },
] as const;
for (const { name, now, access, dailyAsOf, has, hasNot } of feedCases) {
  test(name, async () => {
    setSystemTime(new Date(now));
    const payload = { ...board, access, members: board.members.map((row) => row.changePercent === null ? row : { ...row, dailyAsOf }) };
    setCloudApiFetchTransport(async (input) => Response.json(new URL(String(input)).pathname.endsWith("/members") ? covered : payload));
    let info: PaneFooterSegment[] = [];
    await mountMembers("SPY", { onFooter: (segments) => { info = segments; } });
    const frame = await tui.waitForFrameToContain("Company AAA");
    const footer = frame.split("\n").find((line) => line.includes("1D 2/3"))!;
    for (const text of has) expect(footer).toContain(text);
    for (const text of hasNot) expect(footer).not.toContain(text);
    // The tooltips say what the footer shows, never a feed it does not.
    const titles = info.flatMap((segment) => segment.title ? [segment.title] : []).join("\n");
    const said = has as readonly string[];
    expect(titles.includes("live")).toBe(said.includes("live"));
    expect(titles.includes("close")).toBe(said.some((text) => text.endsWith("close")));
  });
}
