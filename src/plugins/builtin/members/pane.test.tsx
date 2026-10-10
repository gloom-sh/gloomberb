import { afterEach, expect, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PluginRuntimeAccess } from "../../../plugins/runtime";
import type { ContextMenuActionItem, ContextMenuItem } from "../../../types/context-menu";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import { MEMBER_DESTINATIONS } from "../shared/members-menu";
import { fundChangesCache, fundListCache, fundMembersCache } from "./client";
import { MembersPane } from "./pane";
import { board, changes, member } from "./test-fixture";
const tui = createOpenTuiTestHarness();
afterEach(() => { setCloudApiFetchTransport(null); setSharedRegistryForTests(undefined); fundMembersCache.reset(); fundChangesCache.reset(); fundListCache.reset(); });
const covered = { funds: ["IVV", "IJH", "IJR", "IWM", "IWB"].map((ticker) => ({ ticker, name: ticker, aliases: ticker === "IVV" ? ["SPY", "SPX"] : [], changes: "none" as const, asOf: "2026-10-05" })) };
async function mountMembers(symbol: string, { pins = [], runtime = {}, onMenu }: { pins?: string[]; runtime?: Partial<PluginRuntimeAccess>; onMenu?: (menu: ContextMenuItem[]) => void } = {}) {
  for (const cache of [fundMembersCache, fundChangesCache, fundListCache]) cache.attach(new MemoryPluginPersistence());
  const initial = createInitialState(createTestPaneConfig(":memory:", { instanceId: "members", paneId: "members", binding: { kind: "fixed", symbol }, settings: {} }));
  const pluginRuntime = createTestPluginRuntime({ getMarketData: () => null, pinTicker: (symbol) => { pins.push(symbol); }, ...runtime });
  function Harness() {
    const [state, setState] = useState(initial);
    // Stable like the app's: a focused search field re-captures input on a new dispatch and would loop.
    const dispatch = useCallback((action: AppAction) => setState((previous) => appReducer(previous, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId="members" pluginId="members" width={115} height={22} runtime={pluginRuntime}>
      {(body, footer) => { onMenu?.(footer.menu); return <MembersPane paneId="members" paneType="members" focused {...body} />; }}
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
  const frame = await tui.waitForFrameToContain("IBIT is not a covered fund. Covered: IVV, IJH, IJR, IWM, IWB.");
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
