import { describe, expect, test } from "bun:test";
import { contextMenuDivider, type ContextMenuItem } from "../../../types/context-menu";
import { ELECTROBUN_CONTEXT_MENU_ACTION, type ContextMenuSelectMessage } from "../shared/protocol";
import {
  DesktopContextMenuActionScope,
  prepareDesktopContextMenu,
} from "./context-menu";

describe("Electrobun desktop context menu serialization", () => {
  test("preserves roles, dividers, submenu state, accelerators, and checked state", () => {
    const items: ContextMenuItem[] = [
      { type: "role", role: "copy", label: "Copy", accelerator: "CmdOrCtrl+C" },
      contextMenuDivider(),
      {
        id: "tools",
        label: "Tools",
        enabled: true,
        checked: true,
        accelerator: "CmdOrCtrl+T",
        tooltip: "Open tools",
        submenu: [
          { id: "nested", label: "Nested", enabled: false },
        ],
      },
    ];

    const prepared = prepareDesktopContextMenu(items, "request-1");

    expect(prepared.menu).toEqual([
      {
        type: "normal",
        label: "Copy",
        role: "copy",
        enabled: undefined,
        checked: undefined,
        hidden: undefined,
        tooltip: undefined,
        accelerator: "CmdOrCtrl+C",
      },
      { type: "divider" },
      {
        type: "normal",
        label: "Tools",
        tooltip: "Open tools",
        enabled: true,
        checked: true,
        hidden: undefined,
        accelerator: "CmdOrCtrl+T",
        action: undefined,
        data: undefined,
        submenu: [
          {
            type: "normal",
            label: "Nested",
            tooltip: undefined,
            enabled: false,
            checked: undefined,
            hidden: undefined,
            accelerator: undefined,
            action: undefined,
            data: undefined,
            submenu: undefined,
          },
        ],
      },
    ]);
    expect(prepared.actions.size).toBe(0);
  });

  test("custom action items get request-scoped action data and roles do not register callbacks", () => {
    const action = () => {};
    const prepared = prepareDesktopContextMenu([
      { type: "role", role: "paste" },
      { id: "open", label: "Open", onSelect: action },
    ], "request-2");

    expect(prepared.menu[0]).toMatchObject({ role: "paste" });
    expect(prepared.menu[1]).toMatchObject({
      action: `${ELECTROBUN_CONTEXT_MENU_ACTION}:request-2:open`,
      data: { requestId: "request-2", itemId: "open" },
    });
    expect(prepared.actions.get("open")).toBe(action);
    expect(prepared.actions.size).toBe(1);
  });
});

describe("DesktopContextMenuActionScope", () => {
  test("selection messages call the matching callback once", () => {
    let listener: ((message: ContextMenuSelectMessage) => void) | null = null;
    let disposeCount = 0;
    let runCount = 0;
    const scope = new DesktopContextMenuActionScope(
      (_requestId, nextListener) => {
        listener = nextListener;
        return () => {
          disposeCount += 1;
        };
      },
      1000,
      (() => 1) as never,
      (() => {}) as never,
    );

    scope.bind("request-3", new Map([["item", () => { runCount += 1; }]]));
    const emitSelection = listener as ((message: ContextMenuSelectMessage) => void) | null;
    expect(emitSelection).toBeTruthy();
    emitSelection?.({ requestId: "request-3", itemId: "item" });
    emitSelection?.({ requestId: "request-3", itemId: "item" });

    expect(runCount).toBe(1);
    expect(disposeCount).toBe(1);
  });

  test("stale callbacks are cleaned up after the timeout", () => {
    let listener: ((message: ContextMenuSelectMessage) => void) | null = null;
    let timeoutCallback: (() => void) | null = null;
    let disposeCount = 0;
    let runCount = 0;
    const scope = new DesktopContextMenuActionScope(
      (_requestId, nextListener) => {
        listener = nextListener;
        return () => {
          disposeCount += 1;
        };
      },
      1000,
      ((callback: () => void) => {
        timeoutCallback = callback;
        return 1;
      }) as never,
      (() => {}) as never,
    );

    scope.bind("request-4", new Map([["item", () => { runCount += 1; }]]));
    const expireSelection = timeoutCallback as (() => void) | null;
    const emitSelection = listener as ((message: ContextMenuSelectMessage) => void) | null;
    expect(expireSelection).toBeTruthy();
    expect(emitSelection).toBeTruthy();
    expireSelection?.();
    emitSelection?.({ requestId: "request-4", itemId: "item" });

    expect(disposeCount).toBe(1);
    expect(runCount).toBe(0);
  });
});
