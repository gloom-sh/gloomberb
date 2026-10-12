import { describe, expect, test } from "bun:test";
import {
  createShortcutRegistry,
  shouldDeliverShortcut,
  type KeyEventLike,
  type ShortcutOptions,
  type ShortcutRegistry,
} from "./input";

function keyEvent(overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  let defaultPrevented = false;
  let propagationStopped = false;
  return {
    key: "k",
    name: "k",
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    get defaultPrevented() {
      return defaultPrevented;
    },
    get propagationStopped() {
      return propagationStopped;
    },
    preventDefault: () => {
      defaultPrevented = true;
    },
    stopPropagation: () => {
      propagationStopped = true;
    },
    ...overrides,
  };
}

function registerShortcut(
  registry: ShortcutRegistry,
  handler: (event: KeyEventLike) => void,
  options: ShortcutOptions & { isEnabled?: () => boolean } = {},
): () => void {
  return registry.register({
    handler,
    isEnabled: options.isEnabled ?? (() => options.enabled !== false),
    allowsEditable: () => options.allowEditable === true,
    phase: options.phase ?? "normal",
    scope: options.scope,
  });
}

describe("shouldDeliverShortcut", () => {
  test("keeps plain app shortcuts out of editable targets by default", () => {
    expect(shouldDeliverShortcut(keyEvent({ targetEditable: true }), false)).toBe(false);
    expect(shouldDeliverShortcut(keyEvent({ targetEditable: true, name: "down" }), false)).toBe(false);
  });

  test("allows explicit editable handlers and system shortcuts", () => {
    expect(shouldDeliverShortcut(keyEvent({ targetEditable: true }), true)).toBe(true);
    expect(shouldDeliverShortcut(keyEvent({ targetEditable: true, ctrl: true }), false)).toBe(true);
    expect(shouldDeliverShortcut(keyEvent({ targetEditable: true, meta: true }), false)).toBe(true);
  });
});

describe("shortcut registry", () => {
  test("dispatches capture, normal, and bubble phases in order", () => {
    const calls: string[] = [];
    const registry = createShortcutRegistry();
    registerShortcut(registry, () => calls.push("normal-1"));
    registerShortcut(registry, () => calls.push("after"), { phase: "after" });
    registerShortcut(registry, () => calls.push("before"), { phase: "before" });
    registerShortcut(registry, () => calls.push("normal-2"));

    registry.dispatch(keyEvent());

    expect(calls).toEqual(["before", "normal-1", "normal-2", "after"]);
  });

  test("skips the bubble phase after an earlier handler prevents the default action", () => {
    const calls: string[] = [];
    const registry = createShortcutRegistry();
    registerShortcut(registry, (event) => {
      calls.push("normal");
      event.preventDefault();
    });
    registerShortcut(registry, () => calls.push("after"), { phase: "after" });

    registry.dispatch(keyEvent());

    expect(calls).toEqual(["normal"]);
  });

  test("gives the newest scope first refusal and keeps a consumed event in that scope", () => {
    const calls: string[] = [];
    const registry = createShortcutRegistry();
    registerShortcut(registry, () => calls.push("older"), { scope: "older-dialog" });
    registerShortcut(registry, () => calls.push("global"));
    registerShortcut(registry, (event) => {
      calls.push("newer-1");
      event.preventDefault();
    }, { scope: "newer-dialog" });
    registerShortcut(registry, () => calls.push("newer-2"), { scope: "newer-dialog" });

    registry.dispatch(keyEvent());

    expect(calls).toEqual(["newer-1", "newer-2"]);
  });

  test("falls through scopes until a handler consumes the event", () => {
    const calls: string[] = [];
    const registry = createShortcutRegistry();
    registerShortcut(registry, () => calls.push("older"), { scope: "older" });
    registerShortcut(registry, () => calls.push("global"));
    registerShortcut(registry, () => calls.push("newer"), { scope: "newer" });

    registry.dispatch(keyEvent());

    expect(calls).toEqual(["newer", "older", "global"]);
  });

  test("applies editable and enabled gates before scope ordering", () => {
    const calls: string[] = [];
    const registry = createShortcutRegistry();
    registerShortcut(registry, () => calls.push("editable-blocked"), { scope: "newest" });
    registerShortcut(registry, () => calls.push("disabled"), {
      scope: "newest",
      enabled: false,
    });
    registerShortcut(registry, () => calls.push("allowed"), {
      scope: "older",
      allowEditable: true,
    });

    registry.dispatch(keyEvent({ targetEditable: true }));

    expect(calls).toEqual(["allowed"]);
  });

  test("stops propagation immediately and removes cleaned-up handlers", () => {
    const calls: string[] = [];
    const registry = createShortcutRegistry();
    const unregister = registerShortcut(registry, () => calls.push("removed"));
    unregister();
    registerShortcut(registry, (event) => {
      calls.push("stop");
      event.stopPropagation();
    });
    registerShortcut(registry, () => calls.push("skipped"));

    registry.dispatch(keyEvent());

    expect(calls).toEqual(["stop"]);
  });
});

describe("before-dispatch listeners", () => {
  test("run inside the flush, ahead of every handler and the check of which are enabled", () => {
    const calls: string[] = [];
    let enabled = false;
    const registry = createShortcutRegistry({
      flushSync: (run) => {
        calls.push("flush-start");
        run();
        calls.push("flush-end");
      },
    });
    registerShortcut(registry, () => calls.push("capture"), { phase: "capture", isEnabled: () => enabled });
    const remove = registry.beforeDispatch(() => {
      calls.push("listener");
      enabled = true;
    });

    registry.dispatch(keyEvent());
    remove();
    registry.dispatch(keyEvent());

    expect(calls).toEqual(["flush-start", "listener", "flush-end", "capture", "capture"]);
  });
});

describe("modal and fallback phases", () => {
  test("a capture handler runs before a scoped handler that registered after it", () => {
    const registry = createShortcutRegistry();
    const calls: string[] = [];
    registerShortcut(registry, (event) => {
      calls.push("menu");
      event.preventDefault();
      event.stopPropagation();
    }, { phase: "capture", scope: "pane-menu" });
    registerShortcut(registry, () => calls.push("late pane"), { phase: "before", scope: "late-pane" });

    registry.dispatch(keyEvent());
    expect(calls).toEqual(["menu"]);
  });

  test("an idle handler sees only keys nothing else used, after every after handler", () => {
    const registry = createShortcutRegistry();
    const calls: string[] = [];
    registerShortcut(registry, () => calls.push("idle"), { phase: "idle" });
    registerShortcut(registry, () => calls.push("after"), { phase: "after" });
    registerShortcut(registry, (event) => {
      if (event.name === "x") event.preventDefault();
    });

    registry.dispatch(keyEvent({ name: "k" }));
    registry.dispatch(keyEvent({ name: "x" }));
    expect(calls).toEqual(["after", "idle"]);
  });
});

describe("a held key", () => {
  const press = (registry: ShortcutRegistry, overrides: Partial<KeyEventLike>, repeats = 0) => {
    const events = [keyEvent({ ...overrides, repeat: false })];
    for (let index = 0; index < repeats; index += 1) events.push(keyEvent({ ...overrides, repeat: true }));
    for (const event of events) registry.dispatch(event);
    return events;
  };

  test("runs a command chord once, however long it is held, and a second press runs it again", () => {
    const registry = createShortcutRegistry();
    let runs = 0;
    registerShortcut(registry, (event) => {
      runs += 1;
      event.preventDefault();
      event.stopPropagation();
    });

    const copyScreenshot = { name: "c", key: "c", meta: true, super: true, shift: true };
    // 1.5 s at 30 repeats a second.
    const held = press(registry, copyScreenshot, 45);
    expect(runs).toBe(1);
    // The webview still sees the repeats as handled, or it acts on them itself.
    expect(held.every((event) => event.defaultPrevented && event.propagationStopped)).toBe(true);

    press(registry, copyScreenshot);
    expect(runs).toBe(2);
  });

  test("runs Esc, a function key and the menu key once", () => {
    const registry = createShortcutRegistry();
    const seen: string[] = [];
    registerShortcut(registry, (event) => { seen.push(event.name ?? ""); });

    press(registry, { name: "escape", key: "escape" }, 5);
    press(registry, { name: "f1", key: "f1" }, 5);
    press(registry, { name: "contextmenu", key: "contextmenu" }, 5);

    expect(seen).toEqual(["escape", "f1", "contextmenu"]);
  });

  test("keeps moving, scrolling, deleting and typing keys repeating", () => {
    const registry = createShortcutRegistry();
    const seen: string[] = [];
    registerShortcut(registry, (event) => { seen.push(event.name ?? ""); });

    for (const name of ["down", "pagedown", "backspace", "tab", "j", "+", "return", "space"]) {
      press(registry, { name, key: name }, 2);
    }
    // Ctrl+N and Ctrl+P step a list; Ctrl+Left jumps a word.
    press(registry, { name: "n", key: "n", ctrl: true }, 2);
    press(registry, { name: "left", key: "left", ctrl: true }, 2);

    expect(seen.length).toBe(10 * 3);
  });

  test("lets a text field repeat its editing chords but not a command in it", () => {
    const registry = createShortcutRegistry();
    const seen: string[] = [];
    registerShortcut(registry, (event) => { seen.push(event.name ?? ""); }, { allowEditable: true });

    // Delete word held in the command bar.
    press(registry, { name: "w", key: "w", ctrl: true, targetEditable: true }, 3);
    // Ctrl+S submits a form from its field: once.
    press(registry, { name: "s", key: "s", ctrl: true, targetEditable: true }, 3);

    expect(seen.filter((name) => name === "w").length).toBe(4);
    expect(seen.filter((name) => name === "s").length).toBe(1);
  });

  test("does not claim a repeat when its press went unused", () => {
    const registry = createShortcutRegistry();
    const held = press(registry, { name: "z", key: "z", meta: true, super: true }, 3);

    expect(held.some((event) => event.defaultPrevented)).toBe(false);
  });

  test("does not queue the repeats it skipped", () => {
    const registry = createShortcutRegistry();
    const seen: string[] = [];
    registerShortcut(registry, (event) => { seen.push(event.name ?? ""); });

    press(registry, { name: "w", key: "w", meta: true, super: true }, 20);
    const afterRelease = seen.length;
    registry.dispatch(keyEvent({ name: "x", key: "x" }));

    expect(afterRelease).toBe(1);
    expect(seen).toEqual(["w", "x"]);
  });

  test("runs a terminal's presses as they come, since it cannot say which are repeats", () => {
    const registry = createShortcutRegistry();
    let runs = 0;
    registerShortcut(registry, () => { runs += 1; });

    for (let index = 0; index < 5; index += 1) registry.dispatch(keyEvent({ name: "w", key: "w", ctrl: true }));

    expect(runs).toBe(5);
  });
});
