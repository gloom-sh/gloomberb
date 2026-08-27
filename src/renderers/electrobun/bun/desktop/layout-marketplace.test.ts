import { expect, test } from "bun:test";
import { createBlankLayout, createDefaultConfig } from "../../../../types/config";
import {
  applyDesktopLayoutMarketplaceAction,
  parseDesktopLayoutMarketplaceAction,
} from "./layout-marketplace";

test("marketplace layout actions apply against the authoritative desktop snapshot", () => {
  const config = createDefaultConfig("/tmp/gloomberb-marketplace-window-test");
  config.layouts.push({ name: "Second", layout: createBlankLayout(), paneState: {} });
  const paneId = config.layout.instances[0]!.instanceId;
  const snapshot = {
    config,
    paneState: { [paneId]: { cursorSymbol: "NVDA" } },
    focusedPaneId: paneId,
    activePanel: "right" as const,
    statusBarVisible: true,
    mainStateRevision: 7,
  };

  const next = applyDesktopLayoutMarketplaceAction(snapshot, { type: "SWITCH_LAYOUT", index: 1 });

  expect(next.config.activeLayoutIndex).toBe(1);
  expect(next.config.layouts[0]?.paneState?.[paneId]?.cursorSymbol).toBe("NVDA");
  expect(next.paneState[paneId]).toBeUndefined();
  expect(next.mainStateRevision).toBe(7);
  expect(next.layoutChanged).toBe(true);
});

test("marketplace layout action boundary rejects malformed writes", () => {
  expect(parseDesktopLayoutMarketplaceAction({ type: "RENAME_LAYOUT", index: -1, name: "Nope" })).toBeNull();
  expect(parseDesktopLayoutMarketplaceAction({ type: "NEW_LAYOUT", name: " ".repeat(4) })).toBeNull();
  expect(parseDesktopLayoutMarketplaceAction({ type: "SET_CONFIG", config: {} })).toBeNull();
});
