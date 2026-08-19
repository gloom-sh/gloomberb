import { describe, expect, test } from "bun:test";
import type { KeyEventLike } from "../../../react/input";
import { resolveChartComposerShortcut } from "./shortcuts";

function keyEvent(
  name: string,
  overrides: Partial<KeyEventLike> = {},
): KeyEventLike {
  return {
    key: name,
    name,
    sequence: name,
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  };
}

describe("resolveChartComposerShortcut", () => {
  test("leaves shell and editable shortcuts untouched", () => {
    expect(resolveChartComposerShortcut(keyEvent("s", { ctrl: true }), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("s", { meta: true }), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("r", { ctrl: true, shift: true }), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("s", { targetEditable: true }), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("s", { defaultPrevented: true }), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("s", { propagationStopped: true }), 8)).toBeNull();
  });

  test("matches only exact chart shortcuts", () => {
    expect(resolveChartComposerShortcut(keyEvent("s"), 8)).toBe("series");
    expect(resolveChartComposerShortcut(keyEvent("w"), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("m"), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("r"), 8)).toBe("reload");
    expect(resolveChartComposerShortcut(keyEvent("t"), 8)).toBe("resolution");
    expect(resolveChartComposerShortcut(keyEvent("r", { shift: true }), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("3"), 8)).toEqual({ type: "range", index: 2 });
    expect(resolveChartComposerShortcut(keyEvent("9"), 8)).toBeNull();
    expect(resolveChartComposerShortcut(keyEvent("3", { alt: true }), 8)).toBeNull();
  });
});
