import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import { Button } from "../components/ui/button";
import { ChoiceDialog } from "../components/ui/choice-dialog";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../remote/semantic-tree";
import { AppContext, createInitialState, useAppSelector } from "../state/app/context";
import { createStaticAppStore } from "../test-support/app-store";
import { createDefaultConfig } from "../types/config";
import { Text } from "../ui";
import { useDialog } from "../ui/dialog";
import { AppDialogBridge } from "./dialog-bridge";
import { KeybindingsProvider, resolveKeybindings } from "./keybindings";

const tui = createOpenTuiTestHarness();

function DialogBody() {
  const query = useAppSelector((state) => state.commandBarQuery);
  return (
    <>
      <Text>{`query:${query}`}</Text>
      <Button label="Save" onPress={() => {}} />
    </>
  );
}

function OpenOnMount() {
  const dialog = useDialog();
  useEffect(() => {
    void dialog.alert({ content: <DialogBody /> });
  }, [dialog]);
  return null;
}

// The test renderer's dialog host sits outside this tree, as the real one wraps the
// app: without the bridge the body would throw for want of a store and
// register nothing with the app's registry.
test("dialog content reads the app store and registers with the app's remote registry", async () => {
  const registry = createRemoteUiRegistry();
  const state = { ...createInitialState(createDefaultConfig("/tmp/gloomberb-dialog-bridge")), commandBarQuery: "bridged" };
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <AppContext value={createStaticAppStore(state)}>
        <AppDialogBridge />
        <OpenOnMount />
      </AppContext>
    </RemoteUiRegistryProvider>,
    { width: 60, height: 12 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });

  expect(tui.frame()).toContain("query:bridged");
  expect(registry.snapshot().some((node) => node.role === "button" && node.label === "Save")).toBe(true);
});

test("the mounted choice dialog uses the app's custom directions, not the host defaults", async () => {
  const chosen: string[] = [];
  function OpenChoice() {
    const dialog = useDialog();
    useEffect(() => {
      void dialog.prompt<string>({ content: (context) => <ChoiceDialog {...context} title="Pick a letter" choices={[
        { id: "a", label: "Alpha" }, { id: "b", label: "Bravo" }, { id: "c", label: "Charlie" },
      ]} /> }).then((value) => { if (value != null) chosen.push(value); });
    }, [dialog]);
    return null;
  }
  const bindings = resolveKeybindings({ actions: { "navigate-down": "T" } });
  await tui.render(<KeybindingsProvider value={bindings}><AppDialogBridge /><OpenChoice /></KeybindingsProvider>);
  await tui.waitForFrameToContain("Charlie");
  await tui.emitKeypress({ name: "j" });
  await tui.emitKeypress({ name: "down" });
  await tui.emitKeypress({ name: "t" });
  await tui.emitKeypress({ name: "return" });
  expect(chosen).toEqual(["b"]);
});
