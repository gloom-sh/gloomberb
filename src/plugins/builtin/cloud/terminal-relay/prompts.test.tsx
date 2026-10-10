import { describe, expect, test } from "bun:test";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../../../renderers/opentui/test-utils";
import { AssistantApprovalDialog, CallConfirmationDialog } from "./prompts";

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
});
