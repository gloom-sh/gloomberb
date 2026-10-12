import { describe, expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { PaneFooterKeys } from "./keyboard";
import type { CombinedPaneFooter } from "./model";

const tui = createOpenTuiTestHarness({ width: 20, height: 4 });

async function mountFooter(hints: Array<{ key: string; label: string }>) {
  const pressed: string[] = [];
  const footer: CombinedPaneFooter = {
    info: [],
    hints: hints.map((hint) => ({ id: hint.key, ...hint, onPress: () => pressed.push(hint.key) })),
    menu: [],
    keys: [],
  };
  await tui.render(<PaneFooterKeys paneId="pane:a" footer={footer} focused />, { width: 20, height: 4 });
  return pressed;
}

describe("a footer hint key held down", () => {
  test("presses an action hint once, and again for a later press", async () => {
    const pressed = await mountFooter([{ key: "a", label: "dd" }, { key: "Ctrl+S", label: "save" }, { key: "space", label: "pause" }]);

    await tui.emitKeypress({ name: "a" });
    for (let index = 0; index < 10; index += 1) {
      const held = await tui.emitKeypress({ name: "a", repeated: true }, { trackPropagation: true });
      // The repeat is still the app's, so nothing else acts on it.
      expect(held.defaultPrevented).toBe(true);
    }
    await tui.emitKeypress({ name: "s", ctrl: true });
    await tui.emitKeypress({ name: "s", ctrl: true, repeated: true });
    await tui.emitKeypress({ name: "space" });
    await tui.emitKeypress({ name: "space", repeated: true });
    await tui.emitKeypress({ name: "a" });

    expect(pressed).toEqual(["a", "Ctrl+S", "space", "a"]);
  });

  test("keeps pressing the hints that page, step and zoom", async () => {
    const pressed = await mountFooter([{ key: "]", label: "next" }, { key: "+", label: "zoom in" }, { key: ">", label: "newer" }]);

    for (const name of ["]", "+", ">"]) {
      await tui.emitKeypress({ name });
      await tui.emitKeypress({ name, repeated: true });
      await tui.emitKeypress({ name, repeated: true });
    }

    expect(pressed).toHaveLength(9);
  });
});
