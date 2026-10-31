import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState, type ReactNode } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { RoadmapItem, RoadmapPayload } from "../../../api-client/roadmap";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { PaneProps } from "../../../types/plugin";
import { ChangelogPane } from "../changelog";
import { RoadmapClientContext, RoadmapPane, type RoadmapClient } from "./pane";

const PANE = "roadmap:test";
const tui = createOpenTuiTestHarness();
let userSpy: { mockRestore(): void } | undefined;
let fetchSpy: { mockRestore(): void } | undefined;
afterEach(async () => {
  userSpy?.mockRestore();
  userSpy = undefined;
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
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

async function render(client: RoadmapClient, width = 100, height = 16, pane: { paneId: string; component: (props: PaneProps) => ReactNode } = { paneId: "roadmap", component: RoadmapPane }): Promise<string> {
  const Pane = pane.component;
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-roadmap-test", { instanceId: PANE, paneId: pane.paneId, binding: { kind: "none" } }));
  initial.focusedPaneId = PANE;
  function Harness() {
    // The selected and open rows are pane state, so moving them needs a reducer.
    const [state, setState] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setState((current) => appReducer(current, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE} pluginId="application" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
      {(body) => (
        <RoadmapClientContext value={client}>
          <Pane paneId={PANE} paneType={pane.paneId} focused {...body} />
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
  expect(frame).toContain("Loading Roadmap");
  expect(frame).not.toContain("Pro members vote");
});

test("a failed read says so in the body and offers a retry", async () => {
  const frame = await render(client(async () => { throw new Error("Network is unreachable"); }));
  expect(frame).toContain("Roadmap unavailable.");
  expect(frame).toContain("Network is unreachable");
  expect(frame).toContain("Retry");
});

test("an empty roadmap says there is nothing on it yet", async () => {
  const frame = await render(client({ items: [], canVote: false }));
  expect(frame).toContain("Nothing on the roadmap yet.");
  expect(frame).not.toContain("Building");
  expect(frame).not.toContain("Pro members vote");
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

/** A session the test switches: who is signed in, and the listeners told when that changes. */
function switchableSession(first: ReturnType<typeof apiClient.getCurrentUser>) {
  let current = first;
  const listeners = new Set<() => void>();
  const userSpy = spyOn(apiClient, "getCurrentUser").mockImplementation(() => current);
  const subscribeSpy = spyOn(apiClient, "subscribeCurrentUser").mockImplementation((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  return {
    restore: () => { userSpy.mockRestore(); subscribeSpy.mockRestore(); },
    async become(next: ReturnType<typeof apiClient.getCurrentUser>) {
      await act(async () => {
        current = next;
        for (const listener of listeners) listener();
      });
      await settle();
      return tui.frame();
    },
  };
}

const proUser = (id: string) => ({ id, emailVerified: true, plan: "pro", effectivePlan: "pro" }) as ReturnType<typeof apiClient.getCurrentUser>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const VOTED_CHAT = ITEMS.map((entry) => (entry.id === "chat" ? { ...entry, votes: 8, voted: true } : entry));
const chatRow = (frame: string) => frame.split("\n").find((line) => line.includes("Threads in chat"));

test("a sign-out or another account drops the last account's list at once, and a failed read does not bring it back", async () => {
  const session = switchableSession(proUser("pro-a"));
  try {
    const reads: Array<ReturnType<typeof deferred<RoadmapPayload>>> = [];
    const roadmap: RoadmapClient = {
      getRoadmap: () => { const read = deferred<RoadmapPayload>(); reads.push(read); return read.promise; },
      setRoadmapVote: async () => { throw new Error("not in this test"); },
    };
    await render(roadmap);
    await act(async () => { reads[0]!.resolve({ items: VOTED_CHAT, canVote: true }); });
    await settle();
    let frame = tui.frame();
    expect(chatRow(frame)).toMatch(/✓ 8\b/);
    expect(frame).toMatch(/\[v\] unvote/);

    // Signed out: the read is on its way, and nothing of the Pro account shows.
    frame = await session.become(null);
    expect(reads).toHaveLength(2);
    expect(frame).toContain("Loading Roadmap");
    expect(frame).not.toContain("Threads in chat");
    expect(frame).not.toContain("✓");
    expect(frame).not.toMatch(/\[v\]/);
    await act(async () => { reads[1]!.resolve({ items: ITEMS, canVote: false }); });
    await settle();
    frame = tui.frame();
    expect(chatRow(frame)).toMatch(/\b7\b/);
    expect(frame).not.toContain("✓");
    expect(frame).toContain("Pro members vote");

    // Another account whose read fails: the failure, not the list before it.
    frame = await session.become(proUser("pro-b"));
    await act(async () => { reads[2]!.reject(new Error("Network is unreachable")); });
    await settle();
    frame = tui.frame();
    expect(frame).toContain("Roadmap unavailable.");
    expect(frame).not.toContain("Threads in chat");
    expect(frame).not.toContain("Pro members vote");
    expect(frame).not.toMatch(/\[v\]/);
  } finally {
    session.restore();
  }
});

test("a vote still on its way when the account changes leaves the next account's list alone", async () => {
  const session = switchableSession(proUser("pro-a"));
  try {
    const answer = deferred<{ id: string; votes: number; voted: boolean }>();
    const votes: Array<[string, boolean]> = [];
    const roadmap: RoadmapClient = {
      getRoadmap: async () => ({ items: structuredClone(ITEMS), canVote: apiClient.getCurrentUser()?.id === "pro-a" }),
      setRoadmapVote: (id, voted) => { votes.push([id, voted]); return answer.promise; },
    };
    let frame = await render(roadmap);
    frame = await press("v");
    expect(votes).toEqual([["chat", true]]);
    expect(chatRow(frame)).toMatch(/✓ 8\b/);

    frame = await session.become(proUser("pro-b"));
    await act(async () => { answer.resolve({ id: "chat", votes: 8, voted: true }); });
    await settle();
    frame = tui.frame();
    expect(chatRow(frame)).toMatch(/\b7\b/);
    expect(frame).not.toContain("✓");
  } finally {
    session.restore();
  }
});

/** The releases GitHub lists, a nightly build among them; every read of the list is counted. */
const GITHUB_RELEASES = [
  { id: 1912, tag_name: "v0.19.1", name: "v0.19.1 - Roadmap and votes", body: "## Added\n\n- ROADMAP lists what is building, planned and shipped.", published_at: "2026-10-29T09:00:00Z", html_url: "https://github.com/gloom-sh/gloomberb/releases/tag/v0.19.1" },
  { id: 1911, tag_name: "v0.19.1-nightly.20261028.1.gabc1234", prerelease: true, name: "Nightly", body: "", published_at: "2026-10-28T09:00:00Z" },
  { id: 1910, tag_name: "v0.19.0", name: "Faster charts", body: "- Charts draw in half the time.", published_at: "2026-10-22T09:00:00Z", html_url: "https://github.com/gloom-sh/gloomberb/releases/tag/v0.19.0" },
];
let releaseReads = 0;
function stubReleases() {
  const realFetch = globalThis.fetch;
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.github.com/repos/gloom-sh/gloomberb/releases")) return realFetch(input, init);
    releaseReads += 1;
    return new Response(JSON.stringify(GITHUB_RELEASES), { status: 200 });
  }) as typeof fetch);
}

const lines = (frame: string) => frame.split("\n");
const changelogPane = { paneId: "changelog", component: ChangelogPane };

test("ROADMAP opens on the roadmap; the Changelog tab lists the releases, and switching back keeps the roadmap's place", async () => {
  stubReleases();
  signedIn("pro");
  const votes: Array<[string, boolean]> = [];
  let frame = await render(client({ items: ITEMS, canVote: true }, votes));
  expect(lines(frame)[0]).toMatch(/Features\s+Changelog/);
  expect(chatRow(frame)).toMatch(/\b7\b/);
  frame = await press("v");
  expect(chatRow(frame)).toMatch(/✓ 8\b/);

  const reads = releaseReads;
  frame = await press("l");
  expect(lines(frame)[0]).toMatch(/Features\s+Changelog/);
  expect(lines(frame)[1]).toMatch(/DATE\b.*VERSION\s+TITLE/);
  expect(lines(frame).find((line) => line.includes("v0.19.1"))).toMatch(/Oct 29, 2026\s+v0\.19\.1\s+Roadmap and votes/);
  expect(lines(frame).find((line) => line.includes("v0.19.0"))).toMatch(/Oct 22, 2026\s+v0\.19\.0\s+Faster charts/);
  expect(frame).not.toContain("nightly");
  expect(frame).not.toContain("Threads in chat");
  // The roadmap's vote hint belongs to its own view.
  expect(frame).not.toMatch(/\[v\]/);
  expect(releaseReads).toBeLessThanOrEqual(reads + 1);

  frame = await press("h");
  expect(chatRow(frame)).toMatch(/✓ 8\b/);
  expect(frame).toMatch(/\[v\] unvote/);
  expect(frame).not.toContain("Faster charts");

  // Back on the Changelog: the list it read, not a second read.
  const afterFirst = releaseReads;
  frame = await press("l");
  expect(frame).toContain("Faster charts");
  expect(releaseReads).toBe(afterFirst);
  expect(votes).toEqual([["chat", true]]);
});

test("the Changelog view draws what CHG draws, row for row, a release's notes too, from the same read", async () => {
  stubReleases();
  await render(client({ items: ITEMS, canVote: false }));
  const inRoadmap = await press("l");
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  const notesInRoadmap = tui.frame();
  expect(notesInRoadmap).toContain("ROADMAP lists what is building, planned and shipped.");
  expect(notesInRoadmap).toMatch(/\[o\]pen/);
  const reads = releaseReads;
  await tui.destroy();

  // CHG on its own, one row shorter: ROADMAP's first row is its tabs.
  const alone = await render(client({ items: ITEMS, canVote: false }), 100, 15, changelogPane);
  await act(async () => { tui.setup().mockInput.pressEnter(); });
  await settle();
  const notesAlone = tui.frame();

  expect(lines(inRoadmap)[0]).toMatch(/Features\s+Changelog/);
  expect(lines(inRoadmap).slice(1)).toEqual(lines(alone));
  expect(lines(notesInRoadmap).slice(1)).toEqual(lines(notesAlone));
  expect(alone).not.toMatch(/Features\s+Changelog/);
  expect(releaseReads).toBe(reads);
});
