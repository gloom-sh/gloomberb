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
