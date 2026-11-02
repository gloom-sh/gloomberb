import { describe, expect, test } from "bun:test";
import { syncConfigActiveLayoutState } from "../../../../../core/state/app/state";
import { cloneLayout, createDefaultConfig, type AppConfig } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { decodeRpcValue } from "../../../shared/rpc-codec";
import { createDetachedSnapshotFilter } from "../../../view/desktop/window/snapshot";
import type { DesktopBackend, DesktopRpc } from "../backend";
import { createDesktopRpcRegistry } from "../rpc-registry";
import { DesktopStateBroadcaster } from "../state-broadcaster";
import { createDesktopWorkspace } from "./index";
import { handleDesktopWorkspaceRequest } from "./requests";

interface TestWindow {
  rpc: DesktopRpc;
  received: DesktopSharedStateSnapshot[];
}

interface TestPopout extends TestWindow {
  /** The states its bridge let through, which it applies whole. */
  taken: DesktopSharedStateSnapshot[];
  /** Its copy of the config: the one it opened with, or the last state it took. */
  config: () => AppConfig;
}

function setup() {
  const rpcs = createDesktopRpcRegistry<DesktopRpc>();
  const stateBroadcaster = new DesktopStateBroadcaster<DesktopRpc>({ forEachReadyWindowRpc: rpcs.forEachReadyWindowRpc });
  const workspace = createDesktopWorkspace(createDefaultConfig("/tmp/gloomberb-desktop-state-echo"), null);
  const backend = {
    requireWorkspace: () => workspace,
    setConfig: () => {},
    reconcileWindows: () => {},
    fullWindowKey: (rpc: DesktopRpc) => {
      const key = rpcs.getRpcWindowKey(rpc);
      return key && !key.startsWith("detached:") ? key : null;
    },
    detachedWindows: { reconcile: () => {} },
    stateBroadcaster,
  } as unknown as DesktopBackend;
  const open = (key: string, onState?: (snapshot: DesktopSharedStateSnapshot) => void): TestWindow => {
    const received: DesktopSharedStateSnapshot[] = [];
    const rpc = {
      send: {
        "desktop.state": ({ snapshot }: { snapshot: unknown }) => {
          const decoded = decodeRpcValue<DesktopSharedStateSnapshot>(snapshot);
          received.push(decoded);
          onState?.(decoded);
        },
      },
    } as unknown as DesktopRpc;
    rpcs.registerWindowRpc(key, rpc);
    rpcs.markWindowRpcReady(rpc);
    return { rpc, received };
  };
  const openPopout = (paneId: string): TestPopout => {
    const initial = workspace.getSnapshot();
    const take = createDetachedSnapshotFilter(paneId, initial);
    const taken: DesktopSharedStateSnapshot[] = [];
    const window = open(`detached:${paneId}`, (snapshot) => {
      const next = take(snapshot);
      if (next) taken.push(next);
    });
    return { ...window, taken, config: () => (taken.at(-1) ?? initial).config };
  };
  const syncMain = (window: TestWindow, snapshot: DesktopSharedStateSnapshot) => handleDesktopWorkspaceRequest(
    backend,
    window.rpc,
    { method: "desktop.syncMainState", payload: { snapshot } },
  );
  const syncPopout = (window: TestWindow, paneId: string, paneState: Record<string, unknown>) => handleDesktopWorkspaceRequest(
    backend,
    window.rpc,
    { method: "desktop.replaceDetachedPaneState", payload: { paneId, paneState } },
  );
  return { workspace, stateBroadcaster, open, openPopout, syncMain, syncPopout };
}

/** A cursor move as the main window sends it: its reducer mirrors pane state into the open layout the same way. */
function withCursor(snapshot: DesktopSharedStateSnapshot, cursorSymbol: string, revision: number): DesktopSharedStateSnapshot {
  const paneState = { ...snapshot.paneState, "portfolio-list:main": { collectionId: "main", cursorSymbol } };
  const config = syncConfigActiveLayoutState(snapshot.config, paneState, snapshot.focusedPaneId);
  return { ...snapshot, config, paneState, mainStateRevision: revision };
}

describe("desktop state fan-out", () => {
  test("position sync failures and recovery reach a detached pane without a layout or config change", async () => {
    const { workspace, open, openPopout, syncMain } = setup();
    const main = open("main");
    const popout = openPopout("portfolio-list:main");
    const snapshot = workspace.getSnapshot();
    await syncMain(main, { ...snapshot, mainStateRevision: 1, brokerSyncErrors: { demo: "Positions could not be synced. Use Sync to retry." } });
    await syncMain(main, { ...snapshot, mainStateRevision: 2, brokerSyncErrors: {} });
    expect(popout.taken.map((state) => state.brokerSyncErrors)).toEqual([
      { demo: "Positions could not be synced. Use Sync to retry." }, {},
    ]);
    expect(main.received).toEqual([]);
  });

  test("the main window's own sync is not sent back to it; other windows get each change in order", async () => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    const popout = open("detached:chat:main");
    const first = withCursor(workspace.getSnapshot(), "AAPL", 1);
    const second = withCursor(first, "MSFT", 2);

    await syncMain(main, first);
    const late = open("detached:ticker-detail:main");
    await syncMain(main, second);
    // Nothing changed since: the main window is not sent it again.
    stateBroadcaster.sendDesktopState(workspace.getSnapshot());

    expect(main.received).toEqual([]);
    expect(popout.received.map((snapshot) => [snapshot.mainStateRevision, snapshot.paneState["portfolio-list:main"]])).toEqual([
      [1, { collectionId: "main", cursorSymbol: "AAPL" }],
      [2, { collectionId: "main", cursorSymbol: "MSFT" }],
      [2, { collectionId: "main", cursorSymbol: "MSFT" }],
    ]);
    // Each state is numbered, so a window's next sync can name the one it built on.
    expect(late.received.map(({ stateSeq, ...snapshot }) => [typeof stateSeq, snapshot])).toEqual([
      ["number", workspace.getSnapshot()],
      ["number", workspace.getSnapshot()],
    ]);
  });

  test("a popped-out window gets the state its own change made, so its next save keeps the main window's tabs and font size", async () => {
    const { workspace, stateBroadcaster, open, openPopout, syncMain, syncPopout } = setup();
    const main = open("main");
    workspace.popOutPane("portfolio-list:main", { x: 100, y: 120, width: 800, height: 540 });
    const popout = openPopout("portfolio-list:main");

    const shown = workspace.getSnapshot();
    await syncMain(main, {
      ...shown,
      config: {
        ...shown.config,
        fontSize: 15,
        layouts: [...shown.config.layouts, { ...shown.config.layouts[0]!, name: "Added" }],
      },
      mainStateRevision: 1,
    });
    // Its own pane's part did not change, so the pop-out does not take that state.
    expect(popout.received).toHaveLength(1);
    expect(popout.taken).toEqual([]);

    // A cursor move in the pop-out, then the whole-config save it schedules.
    await syncPopout(popout, "portfolio-list:main", { collectionId: "main", cursorSymbol: "MSFT" });
    stateBroadcaster.sendDesktopState(workspace.replaceConfigFromDetachedPane(
      "portfolio-list:main",
      { ...popout.config(), recentTickers: ["MSFT"] },
    ));

    expect(popout.taken.map((snapshot) => snapshot.paneState["portfolio-list:main"])).toEqual([
      { collectionId: "main", cursorSymbol: "MSFT" },
    ]);
    const saved = workspace.getSnapshot().config;
    expect(saved.fontSize).toBe(15);
    expect(saved.layouts.map((entry) => entry.name)).toEqual(["Home", "Monitor", "Macro", "Added"]);
    // The copied tab came with the original's id and got one of its own, which goes back to the main window.
    expect(new Set(main.received[0]!.config.layouts.map((entry) => entry.id)).size).toBe(4);
    expect(main.received.slice(1).map((snapshot) => snapshot.paneState["portfolio-list:main"])).toEqual([
      { collectionId: "main", cursorSymbol: "MSFT" },
      { collectionId: "main", cursorSymbol: "MSFT" },
    ]);
  });

  test("the main window gets the state back when this process changed what it sent", async () => {
    const { workspace, open, syncMain } = setup();
    const main = open("main");
    const popped = workspace.popOutPane("chat:main", { x: 100, y: 120, width: 800, height: 540 });
    workspace.updateDetachedFrame("chat:main", { x: 220, y: 260, width: 640, height: 480 });

    // Built before the move reached the main window.
    await syncMain(main, withCursor({ ...popped, config: { ...popped.config, layout: cloneLayout(popped.config.layout) } }, "AAPL", 1));
    // Behind a revision the workspace already took.
    await syncMain(main, withCursor(workspace.getSnapshot(), "TSLA", 1));

    expect(main.received.map((snapshot) => snapshot.config.layout.detached[0])).toEqual([
      { instanceId: "chat:main", x: 220, y: 260, width: 640, height: 480 },
      { instanceId: "chat:main", x: 220, y: 260, width: 640, height: 480 },
    ]);
    expect(main.received.map((snapshot) => snapshot.paneState["portfolio-list:main"])).toEqual([
      { collectionId: "main", cursorSymbol: "AAPL" },
      { collectionId: "main", cursorSymbol: "AAPL" },
    ]);
  });

  test("a change made in place to what the main window sent still reaches it", async () => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    const sent = withCursor(workspace.getSnapshot(), "AAPL", 1);
    await syncMain(main, sent);

    // The workspace keeps parts of what the main window sent.
    sent.config.portfolios[0]!.name = "Renamed";
    stateBroadcaster.sendDesktopState(workspace.getSnapshot());

    expect(main.received.map((snapshot) => snapshot.config.portfolios[0]?.name)).toEqual(["Renamed"]);
  });

  test("a main window that loads or reloads gets the next state in full", async () => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    await syncMain(main, withCursor(workspace.getSnapshot(), "AAPL", 1));

    // A reload starts from the init state; the next broadcast reaches it even unchanged.
    stateBroadcaster.forgetWindowState(main.rpc);
    stateBroadcaster.sendDesktopState(workspace.getSnapshot());

    expect(main.received.map((snapshot) => snapshot.paneState["portfolio-list:main"])).toEqual([
      { collectionId: "main", cursorSymbol: "AAPL" },
    ]);
  });
});
