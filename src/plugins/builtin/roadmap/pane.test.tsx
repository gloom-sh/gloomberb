import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { RoadmapItem, RoadmapPayload } from "../../../api-client/roadmap";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { RoadmapClientContext, RoadmapPane, type RoadmapClient } from "./pane";

const PANE = "roadmap:test";
const tui = createOpenTuiTestHarness();
let userSpy: { mockRestore(): void } | undefined;
afterEach(async () => {
  userSpy?.mockRestore();
  userSpy = undefined;
  await tui.destroy();
});

const item = (id: string, title: string, status: RoadmapItem["status"], votes: number, extra: Partial<RoadmapItem> = {}): RoadmapItem => ({
  id, title, blurb: `${title} in one line.`, status, shippedAt: null, votes, voted: false, ...extra,
});

const ITEMS: RoadmapItem[] = [
  item("chat", "Threads in chat", "building", 7),
  item("alerts", "Options flow alerts", "planned", 3),
  item("phone", "Screener on the phone", "planned", 12),
  item("scan", "Live scanner", "shipped", 40, { shippedAt: "2026-10-25T12:00:00.000Z" }),
];

function signedIn(plan: "free" | "pro") {
  userSpy = spyOn(apiClient, "getCurrentUser").mockReturnValue({
    id: `${plan}-user`, emailVerified: true, plan, effectivePlan: plan,
  } as ReturnType<typeof apiClient.getCurrentUser>);
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  }
}

async function render(client: RoadmapClient, width = 100, height = 16): Promise<string> {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-roadmap-test", { instanceId: PANE, paneId: "roadmap", binding: { kind: "none" } }));
  initial.focusedPaneId = PANE;
  function Harness() {
    // The selected and open rows are pane state, so moving them needs a reducer.
    const [state, setState] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setState((current) => appReducer(current, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE} pluginId="application" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
      {(body) => (
        <RoadmapClientContext value={client}>
          <RoadmapPane paneId={PANE} paneType="roadmap" focused {...body} />
        </RoadmapClientContext>
      )}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
  await settle();
  return tui.frame();
}

async function press(key: string): Promise<string> {
  await act(async () => { tui.setup().mockInput.pressKey(key); });
  await settle();
  return tui.frame();
}

/** The table commits a keyboard selection once the steps stop (150ms). */
async function pressArrow(direction: "up" | "down"): Promise<string> {
  await act(async () => { tui.setup().mockInput.pressArrow(direction); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  await settle();
  return tui.frame();
}

function client(payload: RoadmapPayload | (() => Promise<RoadmapPayload>), votes: Array<[string, boolean]> = [], vote?: RoadmapClient["setRoadmapVote"]): RoadmapClient {
  return {
    getRoadmap: typeof payload === "function" ? payload : async () => structuredClone(payload),
    setRoadmapVote: async (id, voted) => {
      votes.push([id, voted]);
      if (vote) return vote(id, voted);
      const current = ITEMS.find((entry) => entry.id === id)!;
      return { id, votes: current.votes + (voted ? 1 : 0), voted };
    },
  };
}

test("loading shows the spinner until the roadmap answers", async () => {
  const frame = await render(client(() => new Promise<RoadmapPayload>(() => {})));
  expect(frame).toMatch(/Loading roadmap/);
  expect(frame).not.toContain("Pro members vote");
});

test("a failed read says so in the body and offers a retry", async () => {
  const frame = await render(client(async () => { throw new Error("Network is unreachable"); }));
  expect(frame).toMatch(/[Rr]oadmap unavailable/);
  expect(frame).toContain("Network is unreachable");
  expect(frame).toContain("Retry");
});

test("an empty roadmap says there is nothing on it yet", async () => {
  const frame = await render(client({ items: [], canVote: false }));
  expect(frame).toContain("Nothing on the roadmap yet.");
  expect(frame).not.toContain("Building");
});

test("signed out, the groups and counts read, the one quiet line says Pro members vote, and v does nothing", async () => {
  const votes: Array<[string, boolean]> = [];
  let frame = await render(client({ items: ITEMS, canVote: false }, votes));
  const lines = frame.split("\n");
  const order = ["Building (1)", "Threads in chat", "Planned (2)", "Options flow alerts", "Screener on the phone", "Shipped (1)", "Live scanner"]
    .map((text) => lines.findIndex((line) => line.includes(text)));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(lines.find((line) => line.includes("Screener on the phone"))).toMatch(/Screener on the phone in one line\.\s+12\b/);
  expect(lines.find((line) => line.includes("Live scanner"))).toMatch(/40\s+Oct 25, 2026/);
  expect(frame).toContain("Pro members vote");
  expect(frame).not.toMatch(/\[v\]/);
  expect(frame).not.toMatch(/upgrade/i);

  frame = await press("v");
  expect(votes).toEqual([]);
});

test("a free account reads the same as signed out and cannot vote", async () => {
  signedIn("free");
  const votes: Array<[string, boolean]> = [];
  const frame = await render(client({ items: ITEMS, canVote: false }, votes));
  expect(frame).toContain("Threads in chat");
  expect(frame).toContain("Pro members vote");
  expect(frame).not.toMatch(/\[v\]/);
  await press("v");
  expect(votes).toEqual([]);
});

test("Pro votes on the selected item with v, the count and the check follow, and v again takes it back", async () => {
  signedIn("pro");
  const votes: Array<[string, boolean]> = [];
  let frame = await render(client({ items: ITEMS, canVote: true }, votes));
  expect(frame).not.toContain("Pro members vote");
  expect(frame).toMatch(/\[v\]ote/);

  frame = await press("v");
  expect(votes).toEqual([["chat", true]]);
  expect(frame.split("\n").find((line) => line.includes("Threads in chat"))).toMatch(/✓ 8\b/);
  expect(frame).toMatch(/\[v\] unvote/);

  frame = await press("v");
  expect(votes).toEqual([["chat", true], ["chat", false]]);
  expect(frame.split("\n").find((line) => line.includes("Threads in chat"))).toMatch(/\b7\b/);
  expect(frame).not.toContain("✓");
});

test("a shipped item takes no vote, and a refused vote is said on its row", async () => {
  signedIn("pro");
  const votes: Array<[string, boolean]> = [];
  const refuse: RoadmapClient["setRoadmapVote"] = async () => { throw new ApiRequestError("Pro plan required", 402); };
  let frame = await render(client({ items: ITEMS, canVote: true }, votes, refuse));
  // Down to the shipped item: no vote there.
  for (let step = 0; step < 3; step += 1) frame = await pressArrow("down");
  expect(frame).not.toMatch(/\[v\]/);
  await press("v");
  expect(votes).toEqual([]);

  // Back up to a planned one; the service refuses it.
  await pressArrow("up");
  frame = await press("v");
  expect(votes).toEqual([["phone", true]]);
  const row = frame.split("\n").find((line) => line.includes("Screener on the phone"));
  expect(row).toContain("Pro only");
  expect(row).not.toContain("✓");
});
