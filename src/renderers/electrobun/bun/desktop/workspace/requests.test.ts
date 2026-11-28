import { describe, expect, test } from "bun:test";
import { syncConfigActiveLayoutState } from "../../../../../core/state/app/state";
import { addPaneFloating, removePane } from "../../../../../layout/pane-manager";
import { cloneLayout, createDefaultConfig, createPaneInstance, findPaneInstance, type AppConfig } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { decodeRpcValue } from "../../../shared/rpc-codec";
import { createDetachedSnapshotFilter } from "../../../view/desktop/window/snapshot";
import type { DesktopBackend, DesktopRpc } from "../backend";
import { createDesktopRpcRegistry } from "../rpc-registry";
import { createWorkspaceStateBroadcaster } from "../state-broadcaster";
import { createDesktopWorkspace } from "./index";
import { handleDesktopConfigSave, handleDesktopWorkspaceRequest } from "./requests";

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
  const workspace = createDesktopWorkspace(createDefaultConfig("/tmp/gloomberb-desktop-state-echo"), null);
  const stateBroadcaster = createWorkspaceStateBroadcaster(rpcs, () => workspace);
  const backend = {
    workspace,
    rpcs,
    requireWorkspace: () => workspace,
    setConfig: () => {},
    reconcileWindows: () => {},
    fullWindowKey: (rpc: DesktopRpc) => {
      const key = rpcs.getRpcWindowKey(rpc);
      return key && !key.startsWith("detached:") ? key : null;
    },
    detachedWindows: { reconcile: () => {} },
    commitDesktopSnapshot: async (snapshot: DesktopSharedStateSnapshot) => stateBroadcaster.sendDesktopState(snapshot),
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
  const syncMain = (window: TestWindow, snapshot: DesktopSharedStateSnapshot, baseSeq?: number) => handleDesktopWorkspaceRequest(
    backend,
    window.rpc,
    { method: "desktop.syncMainState", payload: { snapshot, baseSeq } },
  );
  const syncPopout = (window: TestWindow, paneId: string, paneState: Record<string, unknown>) => handleDesktopWorkspaceRequest(
    backend,
    window.rpc,
    { method: "desktop.replaceDetachedPaneState", payload: { paneId, paneState } },
  );
  const save = (window: TestWindow, config: AppConfig) => handleDesktopConfigSave(
    backend, window.rpc, { method: "config.save", payload: { config } },
  );
  return { workspace, stateBroadcaster, open, openPopout, syncMain, syncPopout, save };
}

/** A cursor move as the main window sends it: its reducer mirrors pane state into the open layout the same way. */
function withCursor(snapshot: DesktopSharedStateSnapshot, cursorSymbol: string, revision: number): DesktopSharedStateSnapshot {
  const paneState = { ...snapshot.paneState, "portfolio-list:main": { collectionId: "main", cursorSymbol } };
  const config = syncConfigActiveLayoutState(snapshot.config, paneState, snapshot.focusedPaneId);
  return { ...snapshot, config, paneState, mainStateRevision: revision };
}

describe("desktop state fan-out", () => {
  test("a truly unknown base does not acknowledge an unapplied edit or replace the renderer's unsynced state", async () => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    stateBroadcaster.sendDesktopState(workspace.getSnapshot());
    const shown = main.received.at(-1)!;
    const edited = withCursor({ ...shown, config: { ...shown.config, theme: "paper" } }, "MSFT", 1);
    expect(await syncMain(main, edited, shown.stateSeq! + 1_000)).toBe(false);
    expect(main.received).toHaveLength(1);
    expect(workspace.getSnapshot().config.theme).toBe(shown.config.theme);
    expect(workspace.getSnapshot().mainStateRevision).toBe(shown.mainStateRevision);
    expect(await syncMain(main, edited, shown.stateSeq)).toBeNull();
    expect(workspace.getSnapshot().paneState["portfolio-list:main"]?.cursorSymbol).toBe("MSFT");
  });

  test("a late sync from before pop-out does not reopen Layouts as a floating pane", async () => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    const publish = (snapshot: DesktopSharedStateSnapshot) => stateBroadcaster.sendDesktopState(snapshot);
    publish(workspace.getSnapshot());
    const initial = main.received[0]!;
    const pane = createPaneInstance("layout-marketplace", { instanceId: "layout-marketplace:floating" });
    const layout = addPaneFloating(initial.config.layout, pane, 160, 48);
    const opened = {
      ...initial,
      config: syncConfigActiveLayoutState({ ...initial.config, layout }, initial.paneState, pane.instanceId),
      focusedPaneId: pane.instanceId,
      mainStateRevision: 1,
    };
    await syncMain(main, opened, initial.stateSeq);
    expect(main.received).toHaveLength(1);
    publish(workspace.popOutPane(pane.instanceId, { x: 100, y: 120, width: 800, height: 540 }));
    publish(workspace.closeDetachedPane(pane.instanceId));
    await syncMain(main, {
      ...opened,
      config: { ...opened.config, theme: "paper" },
      mainStateRevision: 2,
    }, initial.stateSeq);

    const current = workspace.getSnapshot();
    expect(current.config.theme).toBe("paper");
    expect(findPaneInstance(current.config.layout, pane.instanceId)).toBeUndefined();
    expect(current.focusedPaneId).not.toBe(pane.instanceId);
  });

  test.each(["immediate", "after ordinary broadcasts"] as const)("a late single-window sync (%s) keeps ordinary edits without reopening Layouts", async (timing) => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    const pane = createPaneInstance("layout-marketplace", { instanceId: "layout-marketplace:late" });
    const initial = workspace.getSnapshot();
    await syncMain(main, {
      ...initial,
      config: { ...initial.config, fontSize: 12, layout: addPaneFloating(initial.config.layout, pane, 160, 48) },
      focusedPaneId: pane.instanceId,
      mainStateRevision: 1,
    });
    const publish = (snapshot: DesktopSharedStateSnapshot) => stateBroadcaster.sendDesktopState(snapshot);
    workspace.popOutPane(pane.instanceId, { x: 100, y: 120, width: 800, height: 540 });
    publish(workspace.replaceConfig({ ...workspace.getSnapshot().config, fontSize: 14 }));
    const held = main.received.at(-1)!;
    expect(held.config.layout.detached.map((entry) => entry.instanceId)).toContain(pane.instanceId);
    expect(held.stateSeq).toBeGreaterThan(0);

    const closed = workspace.closeDetachedPane(pane.instanceId);
    expect(findPaneInstance(closed.config.layout, pane.instanceId)).toBeUndefined();
    publish(closed);
    const churn = timing === "after ordinary broadcasts";
    if (churn) {
      const closedSeq = main.received.at(-1)!.stateSeq!;
      for (let fontSize = 13; fontSize <= 21; fontSize += 1) {
        publish(workspace.replaceConfig({ ...workspace.getSnapshot().config, fontSize }));
      }
      expect(workspace.hasSyncBase("main", closedSeq)).toBe(false);
    }
    const cursorEdit = withCursor(held, "MSFT", 2);
    const ordinaryId = "portfolio-list:main";
    const titleEdit = {
      ...cursorEdit.config.layout,
      instances: cursorEdit.config.layout.instances.map((entry) => entry.instanceId === ordinaryId ? { ...entry, title: "My portfolio" } : entry),
    };
    expect(await syncMain(main, {
      ...cursorEdit,
      config: { ...cursorEdit.config, theme: "paper", layout: titleEdit },
      paneState: { ...cursorEdit.paneState, [pane.instanceId]: { activeTabId: "team" } },
      focusedPaneId: pane.instanceId,
    }, held.stateSeq)).toBeNull();

    const current = workspace.getSnapshot();
    expect(current.config.theme).toBe("paper");
    expect({
      fontSize: current.config.fontSize,
      cursor: current.paneState[ordinaryId]?.cursorSymbol,
      title: findPaneInstance(current.config.layout, ordinaryId)?.title,
    }).toEqual({ fontSize: churn ? 21 : 14, cursor: "MSFT", title: "My portfolio" });
    expect(findPaneInstance(current.config.layout, pane.instanceId)).toBeUndefined();
    expect(current.paneState[pane.instanceId]).toBeUndefined();
    expect(current.focusedPaneId).not.toBe(pane.instanceId);
    const saved = current.config.layouts[current.config.activeLayoutIndex]!;
    expect(saved.focusedPaneId).not.toBe(pane.instanceId);
    expect(saved.paneState?.[ordinaryId]?.cursorSymbol).toBe("MSFT");
    expect(findPaneInstance(saved.layout, ordinaryId)?.title).toBe("My portfolio");

    const shown = main.received.at(-1)!;
    const live = addPaneFloating(shown.config.layout, pane, 160, 48);
    const opened = {
      ...shown,
      config: syncConfigActiveLayoutState({ ...shown.config, layout: live }, shown.paneState, pane.instanceId),
      focusedPaneId: pane.instanceId,
      mainStateRevision: 3,
    };
    const broadcastsBeforeOpen = main.received.length;
    await syncMain(main, opened, shown.stateSeq);
    expect(findPaneInstance(workspace.getSnapshot().config.layout, pane.instanceId)).toBeDefined();
    expect(main.received).toHaveLength(broadcastsBeforeOpen);
    await syncMain(main, {
      ...opened,
      config: { ...opened.config, layout: removePane(live, pane.instanceId) },
      focusedPaneId: shown.focusedPaneId,
      mainStateRevision: 4,
    }, shown.stateSeq);
    expect(findPaneInstance(workspace.getSnapshot().config.layout, pane.instanceId)).toBeUndefined();
  });

  test("config.save cannot reopen a detached Layouts pane after the renderer synced the native close", async () => {
    const { workspace, stateBroadcaster, open, syncMain, save } = setup();
    const main = open("main");
    const pane = createPaneInstance("layout-marketplace", { instanceId: "layout-marketplace:save" });
    const initial = workspace.getSnapshot();
    await syncMain(main, {
      ...initial,
      config: { ...initial.config, layout: addPaneFloating(initial.config.layout, pane, 160, 48) },
      focusedPaneId: pane.instanceId,
      mainStateRevision: 1,
    });
    stateBroadcaster.sendDesktopState(workspace.popOutPane(pane.instanceId, { x: 100, y: 120, width: 800, height: 540 }));
    const pendingConfig = main.received.at(-1)!.config;
    expect(pendingConfig.layout.detached[0]?.instanceId).toBe(pane.instanceId);
    stateBroadcaster.sendDesktopState(workspace.closeDetachedPane(pane.instanceId));
    const closed = main.received.at(-1)!;
    await syncMain(main, { ...closed, mainStateRevision: 2 }, closed.stateSeq);
    expect(findPaneInstance(workspace.getSnapshot().config.layout, pane.instanceId)).toBeUndefined();

    await save(main, { ...pendingConfig, theme: "paper" });
    const saved = workspace.getSnapshot();
    expect(saved.config.theme).toBe("paper");
    expect(findPaneInstance(saved.config.layout, pane.instanceId)).toBeUndefined();
    expect(findPaneInstance(main.received.at(-1)!.config.layout, pane.instanceId)).toBeUndefined();

    const shown = main.received.at(-1)!;
    await syncMain(main, {
      ...shown,
      config: { ...shown.config, layout: addPaneFloating(shown.config.layout, pane, 160, 48) },
      focusedPaneId: pane.instanceId,
      mainStateRevision: 3,
    }, shown.stateSeq);
    await save(main, { ...saved.config, theme: "green" });
    const reopened = workspace.getSnapshot();
    expect(reopened.config.theme).toBe("green");
    expect(reopened.config.layout.floating.map((entry) => entry.instanceId)).toContain(pane.instanceId);
    expect(reopened.focusedPaneId).toBe(pane.instanceId);
  });

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
