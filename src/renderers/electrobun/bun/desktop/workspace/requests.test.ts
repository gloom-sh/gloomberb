import { describe, expect, test } from "bun:test";
import { syncConfigActiveLayoutState } from "../../../../../core/state/app/state";
import { cloneLayout, createDefaultConfig } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { decodeRpcValue } from "../../../shared/rpc-codec";
import type { DesktopBackend, DesktopRpc } from "../backend";
import { createDesktopRpcRegistry } from "../rpc-registry";
import { DesktopStateBroadcaster } from "../state-broadcaster";
import { createDesktopWorkspace } from "./index";
import { handleDesktopWorkspaceRequest } from "./requests";

interface TestWindow {
  rpc: DesktopRpc;
  received: DesktopSharedStateSnapshot[];
}

function setup() {
  const rpcs = createDesktopRpcRegistry<DesktopRpc>();
  const stateBroadcaster = new DesktopStateBroadcaster<DesktopRpc>({ forEachReadyWindowRpc: rpcs.forEachReadyWindowRpc });
  const workspace = createDesktopWorkspace(createDefaultConfig("/tmp/gloomberb-desktop-state-echo"), null);
  const backend = {
    requireWorkspace: () => workspace,
    setConfig: () => {},
    detachedWindows: { reconcile: () => {} },
    stateBroadcaster,
  } as unknown as DesktopBackend;
  const open = (key: string): TestWindow => {
    const received: DesktopSharedStateSnapshot[] = [];
    const rpc = {
      send: {
        "desktop.state": ({ snapshot }: { snapshot: unknown }) => received.push(decodeRpcValue(snapshot)),
      },
    } as unknown as DesktopRpc;
    rpcs.registerWindowRpc(key, rpc);
    rpcs.markWindowRpcReady(rpc);
    return { rpc, received };
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
  return { workspace, stateBroadcaster, open, syncMain, syncPopout };
}

/** A cursor move as the main window sends it: its reducer mirrors pane state into the open layout the same way. */
function withCursor(snapshot: DesktopSharedStateSnapshot, cursorSymbol: string, revision: number): DesktopSharedStateSnapshot {
  const paneState = { ...snapshot.paneState, "portfolio-list:main": { collectionId: "main", cursorSymbol } };
  const config = syncConfigActiveLayoutState(snapshot.config, paneState, snapshot.focusedPaneId);
  return { ...snapshot, config, paneState, mainStateRevision: revision };
}

describe("desktop state fan-out", () => {
  test("the main window's own sync is not sent back to it; other windows get each change in order", async () => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    const popout = open("detached:chat:main");
    const first = withCursor(workspace.getSnapshot(), "AAPL", 1);
    const second = withCursor(first, "MSFT", 2);

    await syncMain(main, first);
    const late = open("detached:ticker-detail:main");
    await syncMain(main, second);
    // Nothing changed since: a repeat of the same state goes to no one.
    stateBroadcaster.sendDesktopState(workspace.getSnapshot());

    expect(main.received).toEqual([]);
    expect(popout.received.map((snapshot) => [snapshot.mainStateRevision, snapshot.paneState["portfolio-list:main"]])).toEqual([
      [1, { collectionId: "main", cursorSymbol: "AAPL" }],
      [2, { collectionId: "main", cursorSymbol: "MSFT" }],
    ]);
    expect(late.received).toEqual([workspace.getSnapshot()]);
  });

  test("a popped-out window's own pane change is not sent back to it; the main window gets it", async () => {
    const { workspace, open, syncMain, syncPopout } = setup();
    const main = open("main");
    const popout = open("detached:chat:main");
    await syncMain(main, withCursor(workspace.getSnapshot(), "AAPL", 1));

    await syncPopout(popout, "chat:main", { draft: "hello" });

    expect(popout.received).toHaveLength(1);
    expect(main.received.map((snapshot) => snapshot.paneState["chat:main"])).toEqual([{ draft: "hello" }]);
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

  test("a window that loads or reloads gets the next state in full", async () => {
    const { workspace, stateBroadcaster, open, syncMain } = setup();
    const main = open("main");
    const popout = open("detached:chat:main");
    await syncMain(main, withCursor(workspace.getSnapshot(), "AAPL", 1));
    expect(popout.received).toHaveLength(1);

    // A reload starts from the init state; the next broadcast reaches it even unchanged.
    stateBroadcaster.forgetWindowState(popout.rpc);
    stateBroadcaster.forgetWindowState(main.rpc);
    stateBroadcaster.sendDesktopState(workspace.getSnapshot());

    expect(popout.received).toHaveLength(2);
    expect(main.received).toHaveLength(1);
    expect(main.received[0]?.paneState["portfolio-list:main"]).toEqual({ collectionId: "main", cursorSymbol: "AAPL" });
  });
});
