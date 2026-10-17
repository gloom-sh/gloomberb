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
      flow = endTrialAfterWarning(dialog!, { isTrialActive: true, trialEndsAt: new Date("2026-10-23T12:00:00Z") }, async () => {
        ended.push("end");
        return { canceled: true, endedNow: true };
      });
      await Bun.sleep(0);
    });
    const frame = await tui.waitForFrameToContain("Cancel Trial?");
    expect(frame).toContain("Cancelling ends your trial and Pro now.");
    expect(frame).toContain("If you keep your trial, you can still cancel before");
    expect(frame).toContain("Oct 23 without being charged.");
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

test("with no trial running it asks nothing and ends nothing", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const ended: string[] = [];
  const result = await endTrialAfterWarning(dialog!, { isTrialActive: false, trialEndsAt: null }, async () => {
    ended.push("end");
    return { canceled: true, endedNow: true };
  });
  await tui.renderFrames(2);
  expect(result).toBeNull();
  expect(ended).toEqual([]);
  expect(tui.frame()).not.toContain("Cancel Trial?");
});
