import { describe, expect, test } from "bun:test";
import { createDefaultConfig } from "../../../../../types/config";
import type { DesktopSharedStateSnapshot } from "../../../../../types/desktop-window";
import { detachedSnapshotKey } from "./snapshot";

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
});
