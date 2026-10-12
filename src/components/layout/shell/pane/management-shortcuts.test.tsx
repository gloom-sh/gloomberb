import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { TestShellPaneKeys } from "../../../../test-support/shell-pane-keys";
import { ONE_SHOT_COOLDOWN_MS } from "../../../../utils/one-shot";

const tui = createOpenTuiTestHarness({ width: 20, height: 4 });

type Calls = Record<string, number>;
type PaneActionOption =
  | "askAboutFocusedPane"
  | "closeFocusedPane"
  | "closeAllFloatingPanes"
  | "copyFocusedPaneScreenshot"
  | "exportFocusedPaneCsv"
  | "shareFocusedPane"
  | "popOutFocusedPane"
  | "toggleFocusedPaneFloating"
  | "toggleFocusedPaneFullscreen"
  | "toggleFocusedPaneNewLayout"
  | "openFocusedPaneSettings"
  | "openLayoutGallery"
  | "gridlockVisiblePanes"
  | "openFocusedPaneMenu";

/** Every one-shot pane shortcut, on the chord the terminal sends for it. */
const ACTIONS: Array<{ option: PaneActionOption; label: string; key: { name: string; ctrl?: boolean; shift?: boolean; alt?: boolean } }> = [
  { option: "closeFocusedPane", label: "Close Pane", key: { name: "w", ctrl: true } },
  { option: "closeAllFloatingPanes", label: "Close Floating Panes", key: { name: "w", ctrl: true, alt: true } },
  { option: "copyFocusedPaneScreenshot", label: "Copy Screenshot", key: { name: "c", ctrl: true, shift: true } },
  { option: "exportFocusedPaneCsv", label: "Export CSV", key: { name: "e", ctrl: true, shift: true } },
  { option: "shareFocusedPane", label: "Share", key: { name: "s", ctrl: true, shift: true } },
  { option: "popOutFocusedPane", label: "Pop Out", key: { name: "o", ctrl: true, shift: true } },
  { option: "toggleFocusedPaneFloating", label: "Dock or Float", key: { name: "d", ctrl: true, shift: true } },
  { option: "toggleFocusedPaneFullscreen", label: "Fullscreen", key: { name: "f", ctrl: true, shift: true } },
  { option: "toggleFocusedPaneNewLayout", label: "New Layout", key: { name: "n", ctrl: true, shift: true } },
  { option: "openFocusedPaneSettings", label: "Settings", key: { name: ",", ctrl: true } },
  { option: "openLayoutGallery", label: "Layout Actions", key: { name: "l", ctrl: true, shift: true } },
  { option: "gridlockVisiblePanes", label: "Tidy Windows", key: { name: "g", ctrl: true, shift: true } },
  { option: "openFocusedPaneMenu", label: "Pane Menu", key: { name: "." } },
  // Alt+A is the chord a terminal delivers; the desktop app's is Cmd+Shift+A.
  { option: "askAboutFocusedPane", label: "Ask Gloom", key: { name: "a", alt: true } },
];

async function mountPaneKeys(calls: Calls) {
  const count = (option: string) => () => {
    calls[option] = (calls[option] ?? 0) + 1;
    return true;
  };
  await tui.render(
    <TestShellPaneKeys
      focusedPaneId="a"
      {...Object.fromEntries(ACTIONS.map(({ option }) => [option, count(option)]))}
    />,
    { width: 20, height: 4 },
  );
}

afterEach(() => setSystemTime());

describe("pane shortcuts held down", () => {
  for (const { option, label, key } of ACTIONS) {
    test(`${label} runs once per press, whether or not the key says it repeats`, async () => {
      setSystemTime(new Date("2026-03-02T10:00:00Z"));
      const calls: Calls = {};
      await mountPaneKeys(calls);

      const first = await tui.emitKeypress(key, { trackPropagation: true });
      expect(calls[option]).toBe(1);
      expect(first.defaultPrevented).toBe(true);

      // 1.5 s of repeats: flagged where the terminal says so, plain presses where it does not.
      for (let elapsed = 0; elapsed < 1_500; elapsed += 50) {
        setSystemTime(new Date(Date.now() + 50));
        const repeat = await tui.emitKeypress(
          { ...key, repeated: elapsed % 100 === 0 },
          { trackPropagation: true },
        );
        // A refused repeat is still the app's: the webview must not act on it.
        expect(repeat.defaultPrevented).toBe(true);
      }
      expect(calls[option]).toBe(1);

      // The key goes up for a moment, then a deliberate press runs it again.
      setSystemTime(new Date(Date.now() + ONE_SHOT_COOLDOWN_MS + 1));
      await tui.emitKeypress(key, { trackPropagation: true });
      expect(calls[option]).toBe(2);
    });
  }

  test("a plain key held past a slow repeat delay does not run its action again", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const calls: Calls = {};
    await mountPaneKeys(calls);

    await tui.emitKeypress({ name: "." }, { trackPropagation: true });
    // The delay before a held key repeats can outlast the cooldown.
    setSystemTime(new Date(Date.now() + 1_800));
    const repeat = await tui.emitKeypress({ name: ".", repeated: true }, { trackPropagation: true });

    expect(calls.openFocusedPaneMenu).toBe(1);
    expect(repeat.defaultPrevented).toBe(true);
  });

  test("a repeat the terminal flags never runs an action, even after the cooldown", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const calls: Calls = {};
    await mountPaneKeys(calls);
    const copy = ACTIONS.find((action) => action.option === "copyFocusedPaneScreenshot")!.key;

    await tui.emitKeypress(copy, { trackPropagation: true });
    setSystemTime(new Date(Date.now() + 5_000));
    await tui.emitKeypress({ ...copy, repeated: true }, { trackPropagation: true });

    expect(calls.copyFocusedPaneScreenshot).toBe(1);
  });

  test("different shortcuts do not wait on each other", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const calls: Calls = {};
    await mountPaneKeys(calls);

    await tui.emitKeypress({ name: "c", ctrl: true, shift: true }, { trackPropagation: true });
    await tui.emitKeypress({ name: "e", ctrl: true, shift: true }, { trackPropagation: true });

    expect(calls).toEqual({ copyFocusedPaneScreenshot: 1, exportFocusedPaneCsv: 1 });
  });

  test("an action that declined does not start a cooldown", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    let available = false;
    let runs = 0;
    await tui.render(
      <TestShellPaneKeys
        focusedPaneId="a"
        shareFocusedPane={() => {
          if (!available) return false;
          runs += 1;
          return true;
        }}
      />,
      { width: 20, height: 4 },
    );
    const share = { name: "s", ctrl: true, shift: true };

    await tui.emitKeypress(share, { trackPropagation: true });
    available = true;
    setSystemTime(new Date(Date.now() + 50));
    await tui.emitKeypress(share, { trackPropagation: true });

    expect(runs).toBe(1);
  });

  test("a held Esc closes one pane", async () => {
    setSystemTime(new Date("2026-03-02T10:00:00Z"));
    let closes = 0;
    await tui.render(
      <TestShellPaneKeys
        focusedPaneId="a"
        closeFocusedPane={() => {
          closes += 1;
          return true;
        }}
      />,
      { width: 20, height: 4 },
    );

    // The first press arms the close; the terminal repeats every 33 ms after 400 ms.
    await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
    setSystemTime(new Date(Date.now() + 400));
    for (let index = 0; index < 60; index += 1) {
      await tui.emitKeypress({ name: "escape" }, { trackPropagation: true });
      setSystemTime(new Date(Date.now() + 33));
    }

    expect(closes).toBe(1);
  });
});
