import { afterEach, expect, test } from "bun:test";
import { act, useReducer } from "react";
import { requestKeybindingCapture } from "../../../app/keybindings";
import { createTestControls, emitKeypress, testRender } from "../../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { cloneLayout, createDefaultConfig, type KeybindingsConfig } from "../../../types/config";
import { Box } from "../../../ui";
import { PaneFooterBar, PaneFooterProvider } from "../../../components/layout/pane/footer";
import { PluginRenderProvider } from "../../runtime";
import { helpModule } from "./index";

const id = "help:test";
const HelpPane = helpModule.panes![0]!.component;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let latestState: AppState | null = null;

function Harness({ keybindings }: { keybindings?: KeybindingsConfig }) {
  const config = createDefaultConfig(`/tmp/gloom-help-keybindings-${process.pid}-${Date.now()}`);
  config.keybindings = keybindings;
  config.layout = { dockRoot: { kind: "pane", instanceId: id }, instances: [{ instanceId: id, paneId: "help", binding: { kind: "none" } }], floating: [], detached: [] };
  config.layouts = [{ name: "Default", layout: cloneLayout(config.layout) }];
  const initial = createInitialState(config);
  initial.focusedPaneId = id;
  const [state, dispatch] = useReducer(appReducer, initial);
  latestState = state;
  return (
    <AppContext value={{ state, dispatch }}>
      <PaneInstanceProvider paneId={id}>
        <PluginRenderProvider pluginId="help" runtime={createTestPluginRuntime()}>
          <PaneFooterProvider>
            {(footer) => (
              <Box width={90} height={30} flexDirection="column">
                <HelpPane paneId={id} paneType="help" focused width={90} height={29} />
                <PaneFooterBar footer={footer} focused width={90} />
              </Box>
            )}
          </PaneFooterProvider>
        </PluginRenderProvider>
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function frame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
  });
}

async function openShortcutsTab() {
  await act(async () => { setup = await testRender(<Harness />, { width: 90, height: 30 }); });
  await frame();
  await act(async () => { await createTestControls(() => setup!).clickFrameText("Shortcuts"); });
  // The table measures its viewport before it can lay columns and rows out.
  await frame();
  await frame();
}

afterEach(async () => {
  if (setup) await act(async () => { setup!.renderer.destroy(); });
  setup = undefined;
  latestState = null;
});

test("rebinding from the help pane captures the next chord, shows the way back, and resets", async () => {
  await openShortcutsTab();
  let text = setup!.captureCharFrame();
  // Sections carry their count, and the actions live in the pane footer.
  expect(text).toContain("Global Keys (12)");
  expect(text).toContain("KEY");
  expect(text).toContain("Open ticker search directly.");
  expect(text).toContain("[Enter]rebind");
  expect(text).toContain("[x]unbind");

  // Down to ticker search, then capture.
  await emitKeypress(setup!, { name: "j" });
  await emitKeypress(setup!, { name: "return" });
  await frame();
  text = setup!.captureCharFrame();
  expect(text).toContain("Press a key");
  expect(text).toContain("[Esc]cancel");

  await emitKeypress(setup!, { name: "y", ctrl: true, shift: true });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ actions: { "ticker-search": "CmdOrCtrl+Shift+Y" } });
  text = setup!.captureCharFrame();
  expect(text).toContain("Ctrl+Shift+Y");
  expect(text).toContain("custom, default `");
  expect(text).toContain("Bound to Ctrl+Shift+Y.");
  // The footer spells out the selected row's note, which the column truncates.
  await emitKeypress(setup!, { name: "k" });
  await emitKeypress(setup!, { name: "j" });
  await frame();
  expect(setup!.captureCharFrame()).toContain("custom, default `");

  await emitKeypress(setup!, { name: "0" });
  await frame();
  expect(latestState?.config.keybindings).toBeUndefined();

  await emitKeypress(setup!, { name: "x" });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ actions: { "ticker-search": null } });
  expect(setup!.captureCharFrame()).toContain("unbound");
});

test("a capture landing on a taken chord still binds and names the other owner", async () => {
  await openShortcutsTab();
  await emitKeypress(setup!, { name: "return" });
  await emitKeypress(setup!, { name: "w", ctrl: true });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ actions: { "command-bar": "CmdOrCtrl+W" } });
  const text = setup!.captureCharFrame();
  expect(text).toContain("Also bound to Close the");
  expect(text).toContain("also Close the focused");
  // The pane row names the collision from its side too.
  expect(text).toContain("also Open the command bar");
});

test("a bind request from the command bar captures a command chord and refuses typing keys", async () => {
  await act(async () => { setup = await testRender(<Harness />, { width: 90, height: 30 }); });
  await frame();
  await act(() => { requestKeybindingCapture({ kind: "command", query: "DES AAPL" }); });
  await frame();
  expect(setup!.captureCharFrame()).toContain('Press a key for "DES AAPL".');

  await emitKeypress(setup!, { name: "a" });
  await frame();
  expect(latestState?.config.keybindings).toBeUndefined();
  expect(setup!.captureCharFrame()).toContain("That key would fire while typing.");

  await emitKeypress(setup!, { name: "1", alt: true });
  await frame();
  expect(latestState?.config.keybindings).toEqual({ commands: { "Alt+1": "DES AAPL" } });
  const text = setup!.captureCharFrame();
  expect(text).toContain("Custom Commands");
  expect(text).toContain("DES AAPL");

  // Escape cancels a capture without touching the table.
  await emitKeypress(setup!, { name: "return" });
  await frame();
  expect(setup!.captureCharFrame()).toContain("Press a key. Esc cancels.");
  await emitKeypress(setup!, { name: "escape" });
  await frame();
  expect(setup!.captureCharFrame()).not.toContain("Press a key");
  expect(latestState?.config.keybindings).toEqual({ commands: { "Alt+1": "DES AAPL" } });
});

test("a review request from the keybinding notice opens Shortcuts on the first conflicting row", async () => {
  await act(async () => {
    setup = await testRender(<Harness keybindings={{ commands: { "Ctrl+W": "DES AAPL" } }} />, { width: 90, height: 30 });
  });
  await frame();
  await act(() => { requestKeybindingCapture({ kind: "review" }); });
  await frame();
  await frame();
  const text = setup!.captureCharFrame();
  expect(text).toContain("Pane Management");
  // The footer spells out the selected row's note, so pane close is selected
  // rather than the first row, whose footer would repeat the raw issue.
  const footer = text.split("\n").find((line) => line.includes("[Enter]rebind"));
  expect(footer).toContain('also "DES AAPL"');
});
