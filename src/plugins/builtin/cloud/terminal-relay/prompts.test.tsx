import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../../remote/semantic-tree";
import { createOpenTuiTestHarness, TestDialogProvider, type TestKeyEvent } from "../../../../renderers/opentui/test-utils";
import { useDialog, type DialogApi } from "../../../../ui/dialog";
import { planUiCall, RELAY_PROMPT_SCOPE, UiCallRefusal } from "./policy";
import { AssistantApprovalDialog, CallConfirmationDialog, dialogRelayPrompts } from "./prompts";

const tui = createOpenTuiTestHarness();
const press = (event: TestKeyEvent) => tui.emitKeypress(event, { frames: 2, afterCommit: true });
const caller = { id: "key:k1", name: "Desk assistant" };
const summary = { title: "placeOrder with Example Broker", lines: [{ label: "Symbol", value: "NVDA" }] };

describe("relay prompts", () => {
  test("the per-call confirmation allows only on y or the Allow button, never on a", async () => {
    const answers: string[] = [];
    await tui.render(
      <CallConfirmationDialog
        resolve={(answer) => answers.push(answer)}
        dismiss={() => {}}
        caller={caller}
        summary={summary}
        signal={new AbortController().signal}
        keyGraceMs={0}
      />,
      { width: 70, height: 20 },
    );
    await tui.waitForFrameToContain("placeOrder with Example Broker");
    await press({ name: "a", sequence: "a" });
    expect(answers).toEqual([]);
    await press({ name: "y", sequence: "y" });
    expect(answers).toEqual(["allow"]);
    await tui.clickFrameText("Allow");
    expect(answers).toEqual(["allow", "allow"]);
    await press({ name: "escape" });
    expect(answers.at(-1)).toBe("deny");
  });

  test("in the approval prompt a means always and s this session", async () => {
    const answers: string[] = [];
    await tui.render(
      <AssistantApprovalDialog
        resolve={(answer) => answers.push(answer)}
        dismiss={() => {}}
        caller={caller}
        signal={new AbortController().signal}
        keyGraceMs={0}
      />,
      { width: 70, height: 20 },
    );
    await tui.waitForFrameToContain("Desk assistant wants to control this terminal");
    await press({ name: "a", sequence: "a" });
    await press({ name: "s", sequence: "s" });
    await press({ name: "n", sequence: "n" });
    expect(answers).toEqual(["always", "session", "deny"]);
  });

  test("every control of either prompt, as the app's dialog host draws it, is the relay's own", async () => {
    const registry = createRemoteUiRegistry();
    let dialog: DialogApi | null = null;
    function Capture() {
      dialog = useDialog();
      return null;
    }
    await tui.render(
      <RemoteUiRegistryProvider registry={registry}>
        <TestDialogProvider>
          <Capture />
        </TestDialogProvider>
      </RemoteUiRegistryProvider>,
      { width: 80, height: 24 },
    );
    const prompts = dialogRelayPrompts(dialog!);
    const nodesOf = async (open: (signal: AbortSignal) => Promise<unknown>, answer: string) => {
      const abort = new AbortController();
      let answered: Promise<unknown> = Promise.resolve();
      await act(async () => {
        answered = open(abort.signal);
        await tui.setup().renderOnce();
      });
      await tui.waitForFrameToContain(answer);
      const nodes = registry.snapshot();
      await act(async () => {
        abort.abort();
        await answered;
      });
      return nodes;
    };

    for (const nodes of [
      await nodesOf((signal) => prompts.askApproval(caller, signal), "Always allow"),
      await nodesOf((signal) => prompts.askConfirmation(caller, summary, signal), "Allow"),
    ]) {
      expect(nodes.some((node) => node.label === "Deny")).toBe(true);
      expect(nodes.filter((node) => node.metadata?.scope !== RELAY_PROMPT_SCOPE)).toEqual([]);
      for (const node of nodes) {
        await expect(planUiCall("ui.invoke", { nodeId: node.id, action: node.actions[0] ?? "press" }, { read: async () => nodes, promptOpen: false }))
          .rejects.toBeInstanceOf(UiCallRefusal);
      }
    }
  });
});
