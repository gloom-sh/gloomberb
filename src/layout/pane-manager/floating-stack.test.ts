import { describe, expect, test } from "bun:test";
import type { LayoutConfig } from "../../types/config";
import { floatAtRect, floatingStacks, gridlockAllPanes, removePane, stackFloatingOnto, unstackFloating } from "./index";

function floatingLayout(): LayoutConfig {
  return {
    dockRoot: null,
    instances: ["a", "b", "c"].map((instanceId) => ({ instanceId, paneId: "chat", binding: { kind: "none" } })),
    floating: [
      { instanceId: "a", x: 0, y: 0, width: 40, height: 20, zIndex: 50 },
      { instanceId: "b", x: 50, y: 0, width: 30, height: 15, zIndex: 51 },
      { instanceId: "c", x: 0, y: 25, width: 30, height: 10, zIndex: 52 },
    ],
    detached: [],
  };
}

describe("floating windows stacked as tabs", () => {
  test("a window dropped on another becomes its shown tab, and moving the stack moves every tab", () => {
    const stacked = stackFloatingOnto(floatingLayout(), "b", "a");
    expect(floatingStacks(stacked.floating)).toEqual(new Map([["b", ["a", "b"]]]));
    expect(stacked.floating.find((entry) => entry.instanceId === "b")).toMatchObject({ x: 0, y: 0, width: 40, height: 20 });

    const moved = floatAtRect(stacked, "b", { x: 10, y: 5, width: 40, height: 20 });
    expect(moved.floating.filter((entry) => entry.stack).map(({ x, y }) => ({ x, y }))).toEqual([{ x: 10, y: 5 }, { x: 10, y: 5 }]);

    // Drawn front to back, the tabs keep the layout's order, whichever one shows.
    const frontToBack = [...stacked.floating].sort((x, y) => (y.zIndex ?? 0) - (x.zIndex ?? 0));
    expect(floatingStacks(frontToBack, stacked.floating)).toEqual(new Map([["b", ["a", "b"]]]));
  });

  test("a stack left with one tab is a window of its own again", () => {
    const stacked = stackFloatingOnto(floatingLayout(), "b", "a");
    expect(unstackFloating(stacked, "b").floating.every((entry) => !entry.stack)).toBe(true);
    expect(removePane(stacked, "a").floating.every((entry) => !entry.stack)).toBe(true);
  });

  test("Tidy docks a floating stack as one spot with its tabs", () => {
    const tidied = gridlockAllPanes(stackFloatingOnto(floatingLayout(), "b", "a"), { x: 0, y: 0, width: 120, height: 40 });
    expect(tidied.floating).toEqual([]);
    const root = tidied.dockRoot;
    expect(root?.kind).toBe("split");
    const stack = root?.kind === "split" ? [root.first, root.second].find((node) => node.kind === "split" && node.tabs) : null;
    expect(stack && stack.kind === "split" ? stack.tabs : null).toEqual({ active: "b" });
  });
});
