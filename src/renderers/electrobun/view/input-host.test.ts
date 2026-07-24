import { describe, expect, test } from "bun:test";
import type { KeyEventLike } from "../../../react/input";
import { dispatchWebAppKeyDown, dispatchWebNativeInterceptors } from "./input-host";

function keyboardEvent(overrides: Record<string, unknown> = {}) {
  let defaultPrevented = false;
  let propagationStopped = false;
  const event = {
    key: "x",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: { tagName: "DIV" },
    get defaultPrevented() { return defaultPrevented; },
    get cancelBubble() { return propagationStopped; },
    isComposing: false,
    preventDefault() { defaultPrevented = true; },
    stopPropagation() { propagationStopped = true; },
    ...overrides,
  };
  return event as unknown as KeyboardEvent;
}

function shortcut(
  handler: (event: KeyEventLike) => void,
  options: {
    allowEditable?: boolean;
    enabled?: boolean;
    interceptNative?: boolean | ((event: KeyEventLike) => boolean);
    order?: number;
    phase?: "before" | "normal" | "after";
  } = {},
) {
  return {
    handlerRef: { current: handler },
    enabledRef: { current: options.enabled !== false },
    allowEditableRef: { current: options.allowEditable === true },
    interceptNativeRef: { current: options.interceptNative ?? false },
    phase: options.phase ?? "normal",
    order: options.order ?? 1,
  };
}

function runNativeDefault(event: KeyboardEvent, action: () => void): void {
  if (!event.defaultPrevented) action();
}

describe("dispatchWebAppKeyDown", () => {
  test("runs only native before-phase interceptors during capture and does not repeat them in bubble", () => {
    const calls: string[] = [];
    const event = keyboardEvent({ key: "x", target: { tagName: "DIV" } });
    const entries = [
      shortcut(() => { calls.push("generic-before"); }, { phase: "before", order: 1 }),
      shortcut(() => { calls.push("native-before"); }, { phase: "before", order: 2, interceptNative: true }),
      shortcut(() => { calls.push("generic-normal"); }, { phase: "normal", order: 3 }),
    ];

    dispatchWebNativeInterceptors(event, entries);
    expect(calls).toEqual(["native-before"]);

    dispatchWebAppKeyDown(event, entries, true);
    expect(calls).toEqual(["native-before", "generic-before", "generic-normal"]);
  });

  test("leaves Tab and Shift+Tab to native focus traversal when no modal handler accepts them", () => {
    let paneTabs = 0;
    const focusMoves: string[] = [];
    const paneShortcut = shortcut(() => { paneTabs += 1; }, { phase: "before" });

    for (const shiftKey of [false, true]) {
      const event = keyboardEvent({ key: "Tab", shiftKey });
      dispatchWebAppKeyDown(event, [paneShortcut]);
      runNativeDefault(event, () => { focusMoves.push(shiftKey ? "backward" : "forward"); });
      expect(event.defaultPrevented).toBe(false);
    }

    expect(paneTabs).toBe(0);
    expect(focusMoves).toEqual(["forward", "backward"]);
  });

  test("lets an active before-phase modal intercept Tab ahead of native focus and pane shortcuts", () => {
    let modalTabs = 0;
    let paneTabs = 0;
    let focusMoves = 0;
    const event = keyboardEvent({ key: "Tab", target: { tagName: "INPUT" } });

    dispatchWebAppKeyDown(event, [
      shortcut(() => { paneTabs += 1; }, { phase: "before", order: 1 }),
      shortcut((key) => {
        if (key.name !== "tab") return;
        modalTabs += 1;
        key.preventDefault();
        key.stopPropagation();
      }, { phase: "before", order: 2, allowEditable: true, interceptNative: true }),
    ]);
    runNativeDefault(event, () => { focusMoves += 1; });

    expect({ modalTabs, paneTabs, focusMoves }).toEqual({ modalTabs: 1, paneTabs: 0, focusMoves: 0 });
    expect(event.defaultPrevented).toBe(true);
  });

  test("limits target-aware native interception to matching editable controls", () => {
    let commandBarTabs = 0;
    let nativeFocusMoves = 0;
    const commandBarShortcut = shortcut((key) => {
      if (key.name !== "tab") return;
      commandBarTabs += 1;
      key.preventDefault();
      key.stopPropagation();
    }, {
      phase: "before",
      allowEditable: true,
      interceptNative: (key) => key.targetEditable === true,
    });

    const editableTargets = [
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
      { tagName: "SPAN", closest: (selector: string) => selector.includes("contenteditable") ? {} : null },
    ];
    const nativeTargets = [
      { tagName: "BUTTON" },
      { tagName: "A", getAttribute: (name: string) => name === "href" ? "/back" : null },
      { tagName: "SUMMARY" },
    ];

    for (const target of [...editableTargets, ...nativeTargets]) {
      const event = keyboardEvent({ key: "Tab", target });
      dispatchWebAppKeyDown(event, [commandBarShortcut]);
      runNativeDefault(event, () => { nativeFocusMoves += 1; });
    }

    expect({ commandBarTabs, nativeFocusMoves }).toEqual({ commandBarTabs: 5, nativeFocusMoves: 3 });
  });

  test("leaves button, link, and summary activation outside target-aware interception", () => {
    const cases = [
      { target: { tagName: "BUTTON" }, keys: ["Enter", " "] },
      { target: { tagName: "A", getAttribute: (name: string) => name === "href" ? "/back" : null }, keys: ["Enter"] },
      { target: { tagName: "SUMMARY" }, keys: ["Enter", " "] },
    ];
    let commandBarActivations = 0;
    let nativeActivations = 0;
    const commandBarShortcut = shortcut(() => {
      commandBarActivations += 1;
    }, {
      phase: "before",
      allowEditable: true,
      interceptNative: (key) => key.targetEditable === true,
    });

    for (const { target, keys } of cases) {
      for (const key of keys) {
        const event = keyboardEvent({ key, target });
        dispatchWebAppKeyDown(event, [commandBarShortcut]);
        runNativeDefault(event, () => { nativeActivations += 1; });
      }
    }

    expect({ commandBarActivations, nativeActivations }).toEqual({
      commandBarActivations: 0,
      nativeActivations: 5,
    });
  });

  test("keeps native control defaults ahead of focused-pane shortcuts", () => {
    const cases = [
      { target: { tagName: "BUTTON" }, keys: ["Enter", "Return", " "] },
      { target: { tagName: "A", getAttribute: (name: string) => name === "href" ? "/news" : null }, keys: ["Enter"] },
      { target: { tagName: "SUMMARY" }, keys: ["Enter", " "] },
    ];
    let paneActivations = 0;
    let nativeDefaults = 0;
    const paneShortcut = shortcut(() => { paneActivations += 1; });

    for (const { target, keys } of cases) {
      for (const key of keys) {
        const event = keyboardEvent({ key, target });
        dispatchWebAppKeyDown(event, [paneShortcut]);
        runNativeDefault(event, () => { nativeDefaults += 1; });
        expect(event.defaultPrevented).toBe(false);
      }
    }

    expect(paneActivations).toBe(0);
    expect(nativeDefaults).toBe(6);
  });

  test("lets Window Edit commit with Enter even when a native header button retains focus", () => {
    let commits = 0;
    let paneActivations = 0;
    let buttonClicks = 0;
    const event = keyboardEvent({ key: "Enter", target: { tagName: "BUTTON" } });

    dispatchWebAppKeyDown(event, [
      shortcut(() => { paneActivations += 1; }, { phase: "normal", order: 1 }),
      shortcut((key) => {
        if (key.name !== "return") return;
        commits += 1;
        key.preventDefault();
        key.stopPropagation();
      }, { phase: "before", order: 2, allowEditable: true, interceptNative: true }),
    ]);
    runNativeDefault(event, () => { buttonClicks += 1; });

    expect({ commits, paneActivations, buttonClicks }).toEqual({ commits: 1, paneActivations: 0, buttonClicks: 0 });
    expect(event.defaultPrevented).toBe(true);
  });

  test("does not leak native editing targets into generic shortcuts", () => {
    const targets = [
      { tagName: "INPUT" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
      { tagName: "SPAN", closest: (selector: string) => selector.includes("contenteditable") ? {} : null },
    ];
    let genericCalls = 0;
    const genericShortcut = shortcut(() => { genericCalls += 1; });

    for (const target of targets) {
      for (const key of ["x", "Enter", " "]) {
        const event = keyboardEvent({ key, target });
        dispatchWebAppKeyDown(event, [genericShortcut]);
        expect(event.defaultPrevented).toBe(false);
      }
    }

    expect(genericCalls).toBe(0);
  });

  test("returns unhandled modal-native keys to the browser", () => {
    let buttonClicks = 0;
    const event = keyboardEvent({ key: " ", target: { tagName: "BUTTON" } });

    dispatchWebAppKeyDown(event, [
      shortcut(() => {}, { phase: "before", interceptNative: true }),
    ]);
    runNativeDefault(event, () => { buttonClicks += 1; });

    expect(buttonClicks).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  });
});
