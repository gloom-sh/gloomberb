import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { act, useReducer } from "react";
import { requestKeybindingCapture } from "../../../app/keybindings";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { flushPendingPersistence } from "../../../state/persist-scheduler";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { KeybindingsConfig } from "../../../types/config";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { helpModule } from "./index";

const id = "help:test";
const HelpPane = helpModule.panes![0]!.component;
const tui = createOpenTuiTestHarness();
// Polls of 50ms: a generous bound for a loaded runner, where a passing run returns on the first.
const WAIT_ATTEMPTS = 60;
let latestState: AppState | null = null;
let dataDir = "";

function Harness({ keybindings }: { keybindings?: KeybindingsConfig }) {
  const config = createTestPaneConfig(dataDir, { instanceId: id, paneId: "help", binding: { kind: "none" } });
  config.keybindings = keybindings;
  const initial = createInitialState(config);
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  latestState = state;
  return (
    <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="help" runtime={createTestPluginRuntime()} width={90} height={30}>
      {(body) => <HelpPane paneId={id} paneType="help" focused {...body} />}
    </TestPaneFrame>
  );
}

async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tui.setup().renderOnce();
  });
}

async function openShortcutsTab() {
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 30 }); });
  await frame();
  await act(async () => { await tui.clickFrameText("Shortcuts"); });
  // The table measures its viewport before it can lay columns and rows out.
  await tui.waitForFrameToContain("Global Keys (13)", WAIT_ATTEMPTS);
}

// Rebinding saves the config for real, so each test gets a directory of its own.
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gloom-help-keybindings-"));
});

afterEach(async () => {
  latestState = null;
  // Let the saves a rebind started land before their directory goes.
  await flushPendingPersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test("rebinding from the help pane captures the next chord, shows the way back, and resets", async () => {
  await openShortcutsTab();
  let text = tui.frame();
  // Sections carry their count, and the actions live in the pane footer.
  expect(text).toContain("Global Keys (13)");
  expect(text).toContain("KEY");
  expect(text).toContain("Open ticker search directly.");
  expect(text).toContain("[Enter]rebind");
  expect(text).toContain("[x]unbind");

  // Down to ticker search, then capture.
  await tui.emitKeypress({ name: "j" });
  await tui.emitKeypress({ name: "return" });
  await frame();
  text = tui.frame();
  expect(text).toContain("Press a key");
  expect(text).toContain("[Esc]cancel");

  await tui.emitKeypress({ name: "y", ctrl: true, shift: true });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ actions: { "ticker-search": "CmdOrCtrl+Shift+Y" } });
  text = tui.frame();
  expect(text).toContain("Ctrl+Shift+Y");
  expect(text).toContain("custom, default `");
  expect(text).toContain("Bound to Ctrl+Shift+Y.");
  // The table commits a step at once only after a pause, so the key pressed
  // right after one still acts on the row under the cursor.
  await tui.emitKeypress({ name: "k" });
  await tui.emitKeypress({ name: "j" });
  await tui.emitKeypress({ name: "0" });
  await frame();
  expect(latestState?.config.keybindings).toBeUndefined();

  await tui.emitKeypress({ name: "x" });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ actions: { "ticker-search": null } });
  expect(tui.frame()).toContain("unbound");
});

test("a capture landing on a taken chord still binds and names the other owner", async () => {
  await openShortcutsTab();
  await tui.emitKeypress({ name: "return" });
  await tui.emitKeypress({ name: "w", ctrl: true });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ actions: { "command-bar": "CmdOrCtrl+W" } });
  const text = tui.frame();
  expect(text).toContain("Also bound to Close the");
  expect(text).toContain("also Close the focused");
  // The pane row names the collision from its side too.
  expect(text).toContain("also Open the command bar");
});

test("a bind request from the command bar captures a command chord and refuses typing keys", async () => {
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 30 }); });
  await frame();
  await act(() => { requestKeybindingCapture({ kind: "command", query: "DES AAPL" }); });
  await frame();
  expect(tui.frame()).toContain('Press a key for "DES AAPL".');

  await tui.emitKeypress({ name: "a" });
  await frame();
  expect(latestState?.config.keybindings).toBeUndefined();
  expect(tui.frame()).toContain("That key would fire while typing.");

  await tui.emitKeypress({ name: "1", alt: true });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ commands: { "Alt+1": "DES AAPL" } });
  const text = tui.frame();
  expect(text).toContain("Custom Commands");
  expect(text).toContain("DES AAPL");

  // Escape cancels a capture without touching the table.
  await tui.emitKeypress({ name: "return" });
  await frame();
  expect(tui.frame()).toContain("Press a key. Esc cancels.");
  await tui.emitKeypress({ name: "escape" });
  await frame();
  expect(tui.frame()).not.toContain("Press a key");
  expect(latestState?.config.keybindings).toEqual({ commands: { "Alt+1": "DES AAPL" } });
});

test("a review request from the keybinding notice opens Shortcuts on the first conflicting row", async () => {
  await act(async () => {
    await tui.render(<Harness keybindings={{ commands: { "Ctrl+W": "DES AAPL" } }} />, { width: 90, height: 30 });
  });
  await frame();
  await act(() => { requestKeybindingCapture({ kind: "review" }); });
  await frame();
  await frame();
  const text = tui.frame();
  expect(text).toContain("Pane Management");
  // The footer spells out the selected row's note, so pane close is selected
  // rather than the first row, whose footer would repeat the raw issue.
  const footer = text.split("\n").find((line) => line.includes("[Enter]rebind"));
  expect(footer).toContain('also "DES AAPL"');
});
