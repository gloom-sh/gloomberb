import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, TestDialogProvider, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { useDialog, type DialogApi } from "../../../ui/dialog";
import { endTrialAfterWarning } from "./trial-cancel";

const tui = createOpenTuiTestHarness({ width: 80, height: 24 });

let dialog: DialogApi | null = null;
function DialogCapture() {
  dialog = useDialog();
  return null;
}

// Ending a trial ends Pro on the spot and cannot be undone, so nothing may
// reach the server before the warning, and a stray Enter must keep the trial.
test("the trial ends only after its warning, and Enter or Esc keep it", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const ended: string[] = [];
  const answer = async (keys: TestKeyEvent[]) => {
    let flow: Promise<{ endedNow: boolean } | null> = Promise.resolve(null);
    await act(async () => {
      flow = endTrialAfterWarning(dialog!, new Date("2026-10-23T12:00:00Z"), async () => {
        ended.push("end");
        return { canceled: true, endedNow: true };
      });
      await Bun.sleep(0);
    });
    const frame = await tui.waitForFrameToContain("Cancel Trial?");
    expect(frame).toContain("Cancelling ends your trial and Pro now.");
    expect(frame).toContain("cancel any time before Oct 23");
    expect(ended).toEqual([]);
    for (const key of keys) await tui.emitKeypress(key);
    const result = await act(() => flow);
    await tui.waitForFrameToExclude("Cancel Trial?");
    return result;
  };

  expect(await answer([{ name: "return" }])).toBeNull();
  expect(await answer([{ name: "escape" }])).toBeNull();
  expect(ended).toEqual([]);

  expect(await answer([{ name: "y", sequence: "y" }])).toEqual({ endedNow: true });
  expect(ended).toEqual(["end"]);
});
