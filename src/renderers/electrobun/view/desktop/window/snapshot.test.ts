import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { createDetachedSnapshotFilter, detachedSnapshotKey } from "./snapshot";

function createSnapshot(): DesktopSharedStateSnapshot {
  const config = createDefaultConfig("/tmp/gloomberb-test");
  config.layout.detached = [{ instanceId: "ticker-detail:main", x: 20, y: 20, width: 640, height: 420 }];
  return {
    config,
    paneState: {
      "portfolio-list:main": { cursorSymbol: "AAPL", collectionId: "main" },
      "ticker-detail:main": { activeTabId: "overview" },
    },
    focusedPaneId: "portfolio-list:main",
    statusBarVisible: true,
  };
}

describe("detached desktop snapshots", () => {
  test("ignores unrelated window state", () => {
    const snapshot = createSnapshot();
    const key = detachedSnapshotKey(snapshot, "ticker-detail:main");

    expect(detachedSnapshotKey({
      ...snapshot,
      focusedPaneId: "chat:main",
      paneState: {
        ...snapshot.paneState,
        "chat:main": { draft: "unrelated" },
      },
    }, "ticker-detail:main")).toBe(key);
  });

  test("tracks the detached pane and its follow source", () => {
    const snapshot = createSnapshot();
    const key = detachedSnapshotKey(snapshot, "ticker-detail:main");

    expect(detachedSnapshotKey({
      ...snapshot,
      paneState: {
        ...snapshot.paneState,
        "ticker-detail:main": { activeTabId: "financials" },
      },
    }, "ticker-detail:main")).not.toBe(key);

    expect(detachedSnapshotKey({
      ...snapshot,
      paneState: {
        ...snapshot.paneState,
        "portfolio-list:main": { cursorSymbol: "MSFT", collectionId: "main" },
      },
    }, "ticker-detail:main")).not.toBe(key);
  });

  test("takes a telemetry change, so Turn off in the main window stops a popped-out window counting", () => {
    const snapshot = createSnapshot();
    const take = createDetachedSnapshotFilter("ticker-detail:main", snapshot);
    const turnedOff: DesktopSharedStateSnapshot = {
      ...snapshot,
      config: { ...snapshot.config, telemetry: { attention: false } },
    };

    expect(take(turnedOff)?.config.telemetry?.attention).toBe(false);
  });

  test("drops a state that changes only the tabs or font size, then takes the next one its pane changed, whole", () => {
    const snapshot = createSnapshot();
    const take = createDetachedSnapshotFilter("ticker-detail:main", snapshot);
    const retabbed: DesktopSharedStateSnapshot = {
      ...snapshot,
      config: {
        ...snapshot.config,
        fontSize: 15,
        layouts: [...snapshot.config.layouts, { ...snapshot.config.layouts[0]!, name: "Added" }],
      },
    };
    const ownChange: DesktopSharedStateSnapshot = {
      ...retabbed,
      paneState: { ...retabbed.paneState, "ticker-detail:main": { activeTabId: "financials" } },
    };

    expect(take(retabbed)).toBeNull();
    const taken = take(ownChange);
    expect(taken?.config.fontSize).toBe(15);
    expect(taken?.config.layouts.at(-1)?.name).toBe("Added");
    expect(taken?.focusedPaneId).toBe("ticker-detail:main");
    // The same state again is dropped: the filter moved on with it.
    expect(take(ownChange)).toBeNull();
  });
});
