import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness, TestDialogProvider, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { useDialog, type DialogApi } from "../../../ui/dialog";
import { endTrialAfterWarning } from "./trial-cancel";

const tui = createOpenTuiTestHarness({ width: 80, height: 24 });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

let dialog: DialogApi | null = null;
function DialogCapture() {
  dialog = useDialog();
  return null;
}

const TRIAL = { isTrialActive: true, trialEndsAt: new Date("2026-10-23T12:00:00Z") };

/** Opens the warning; `answer` drives it and resolves with what the flow returned. */
async function openWarning(end: Parameters<typeof endTrialAfterWarning>[2]) {
  let flow: Promise<{ endedNow: boolean } | null> = Promise.resolve(null);
  await act(async () => {
    flow = endTrialAfterWarning(dialog!, TRIAL, end);
    await Bun.sleep(0);
  });
  await tui.waitForFrameToContain("Cancel Trial?");
  return {
    async answer(...steps: Array<TestKeyEvent | (() => Promise<void>)>) {
      for (const step of steps) {
        if (typeof step === "function") {
          await act(async () => {
            await step();
            await tui.setup().renderOnce();
          });
        } else {
          await tui.emitKeypress(step, { trackPropagation: true });
        }
      }
      const result = await act(() => flow);
      await tui.waitForFrameToExclude("Cancel Trial?");
      return result;
    },
  };
}

// Ending a trial ends Pro on the spot and cannot be undone, so nothing may
// reach the server before the warning, and a stray Enter must keep the trial.
// The reason it asks is optional: `y` alone still ends it.
test("the trial ends only after its warning, Enter or Esc keep it, and no reason is needed", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const ended: unknown[] = [];
  const end = async (feedback: unknown) => {
    ended.push(feedback);
    return { canceled: true, endedNow: true };
  };

  const kept = await openWarning(end);
  const frame = tui.frame();
  expect(frame).toContain("Cancelling ends your trial and Pro now.");
  expect(frame).toContain("Oct 23 without being charged.");
  expect(frame).toContain("What made you decide to cancel? (optional)");
  // The buttons stay in view on the smallest terminal.
  expect(frame).toContain("End Trial Now");
  expect(ended).toEqual([]);
  expect(await kept.answer({ name: "return" })).toBeNull();
  expect(await (await openWarning(end)).answer({ name: "escape" })).toBeNull();
  expect(ended).toEqual([]);

  expect(await (await openWarning(end)).answer({ name: "y", sequence: "y" })).toEqual({ endedNow: true });
  expect(ended).toEqual([{}]);
});

test("the cancel request carries the reason and note picked, and neither when none were", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    expect(new URL(request.url).pathname).toEndWith("/stripe/subscription/cancel");
    bodies.push(await request.json());
    return Response.json({ canceled: true, endedNow: true });
  }) as typeof fetch;
  const end = (feedback: Parameters<typeof apiClient.endCloudTrial>[0]) => apiClient.endCloudTrial(feedback);

  const picked = await openWarning(end);
  const result = await picked.answer(
    // Third reason, then the note: `y` and Enter typed there neither end nor keep the trial.
    { name: "down" }, { name: "down" }, { name: "down" },
    { name: "tab" },
    () => tui.setup().mockInput.typeText(" only needed options, yes "),
    { name: "return" },
    { name: "y", sequence: "y" },
  );
  expect(result).toEqual({ endedNow: true });
  expect(bodies).toEqual([{ reason: "too_expensive", comment: "only needed options, yes", endTrialNow: true }]);

  expect(await (await openWarning(end)).answer({ name: "y", sequence: "y" })).toEqual({ endedNow: true });
  expect(bodies[1]).toEqual({ endTrialNow: true });
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
