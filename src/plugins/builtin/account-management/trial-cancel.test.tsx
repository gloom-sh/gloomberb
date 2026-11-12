import { afterEach, expect, test } from "bun:test";
import { act, createRef, useState } from "react";
import { apiClient } from "../../../api-client";
import { TextField } from "../../../components/ui/fields";
import { createOpenTuiTestHarness, TestDialogProvider, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { useDialog, type DialogApi } from "../../../ui/dialog";
import type { InputRenderable } from "../../../ui/host";
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
const Y: TestKeyEvent = { name: "y", sequence: "y" };
type Step = TestKeyEvent | TestKeyEvent[] | (() => Promise<void>);

/** An `end` that records what it was asked to send. */
function recordEnds() {
  const ended: unknown[] = [];
  const end = async (feedback: unknown) => {
    ended.push(feedback);
    return { canceled: true, endedNow: true };
  };
  return { ended, end };
}

/** The cancel requests the real API client sends, answered as the server does. */
function recordRequests() {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    expect(new URL(request.url).pathname).toEndWith("/stripe/subscription/cancel");
    bodies.push(await request.json());
    return Response.json({ canceled: true, endedNow: true });
  }) as typeof fetch;
  return bodies;
}

/** Opens the warning: `press` drives it, `result` waits for what the flow returned. */
async function openWarning(end: Parameters<typeof endTrialAfterWarning>[2]) {
  let flow: Promise<{ endedNow: boolean } | null> = Promise.resolve(null);
  await act(async () => {
    flow = endTrialAfterWarning(dialog!, TRIAL, end);
    await Bun.sleep(0);
  });
  await tui.waitForFrameToContain("Cancel Trial?");
  const press = async (...steps: Step[]) => {
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
  };
  const result = async () => {
    const answer = await act(() => flow);
    await tui.waitForFrameToExclude("Cancel Trial?");
    return answer;
  };
  return {
    press,
    result,
    async answer(...steps: Step[]) {
      await press(...steps);
      return result();
    },
  };
}

const typeText = (text: string) => () => tui.setup().mockInput.typeText(text);

// Ending a trial ends Pro on the spot and cannot be undone, so nothing may
// reach the server before the warning, and a stray Enter must keep the trial.
// The reason it asks is optional: `y` alone still ends it.
test("the trial ends only after its warning, Enter or Esc keep it, and no reason is needed", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const { ended, end } = recordEnds();

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

  expect(await (await openWarning(end)).answer(Y)).toEqual({ endedNow: true });
  expect(ended).toEqual([{}]);
});

test("the cancel request carries the reason and note picked, and neither when none were", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const bodies = recordRequests();
  const end = (feedback: Parameters<typeof apiClient.endCloudTrial>[0]) => apiClient.endCloudTrial(feedback);

  const picked = await openWarning(end);
  // Third reason, then the note: `y` typed there is text, and Enter only leaves it.
  await picked.press({ name: "down" }, { name: "down" }, { name: "down" }, { name: "tab" }, typeText(" only needed options, yes "), { name: "return" });
  expect(bodies).toEqual([]);
  expect(tui.frame()).toContain("Cancel Trial?");
  // Out of the note, `y` is the dialog's again.
  expect(await picked.answer(Y)).toEqual({ endedNow: true });
  expect(bodies).toEqual([{ reason: "too_expensive", comment: "only needed options, yes", endTrialNow: true }]);

  expect(await (await openWarning(end)).answer(Y)).toEqual({ endedNow: true });
  expect(bodies[1]).toEqual({ endTrialNow: true });

  // A reason picked and then cleared with Space goes as none.
  expect(await (await openWarning(end)).answer({ name: "down" }, { name: "space", sequence: " " }, Y)).toEqual({ endedNow: true });
  expect(bodies[2]).toEqual({ endTrialNow: true });

  // The server counts UTF-16 units: a note at its limit is cut before an emoji, never through it.
  await apiClient.endCloudTrial({ comment: `${"a".repeat(499)}😀` });
  expect(bodies[3]).toEqual({ comment: "a".repeat(499), endTrialNow: true });
});

test("Esc keeps the trial from the note and with a reason picked", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const { ended, end } = recordEnds();

  expect(await (await openWarning(end)).answer({ name: "down" }, { name: "tab" }, typeText("y"), { name: "escape" })).toBeNull();
  expect(await (await openWarning(end)).answer({ name: "down" }, { name: "down" }, { name: "escape" })).toBeNull();
  expect(ended).toEqual([]);
});

test("End Trial Now ends the trial on a click, and once however often it is pressed", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const { ended, end } = recordEnds();

  const clicked = await openWarning(end);
  await tui.clickFrameText("End Trial Now");
  expect(await clicked.result()).toEqual({ endedNow: true });
  expect(ended).toEqual([{}]);

  // Two clicks, and two `y`, before the dialog has gone.
  const doubleClicked = await openWarning(end);
  const rows = tui.frame().split("\n");
  const row = rows.findIndex((line) => line.includes("End Trial Now"));
  const col = rows[row]!.indexOf("End Trial Now") + 1;
  await act(async () => {
    await tui.setup().mockMouse.click(col, row);
    await tui.setup().mockMouse.click(col, row);
  });
  expect(await doubleClicked.result()).toEqual({ endedNow: true });
  expect(await (await openWarning(end)).answer([Y, Y])).toEqual({ endedNow: true });
  expect(ended).toEqual([{}, {}, {}]);
});

// The dialog takes every key from what is under it, a field that has the
// focus too: only its own note takes typing.
test("a field under the warning that has the focus takes neither y nor Enter from it", async () => {
  let typed = "";
  const field = createRef<InputRenderable>();
  function FieldUnder() {
    const [value, setValue] = useState("");
    typed = value;
    return <TextField value={value} inputRef={field} width={20} onChange={setValue} />;
  }
  await tui.render(<TestDialogProvider><DialogCapture /><FieldUnder /></TestDialogProvider>);
  const { ended, end } = recordEnds();
  const focusField = async () => { field.current!.focus!(); };

  expect(await (await openWarning(end)).answer(focusField, { name: "return" })).toBeNull();
  expect(await (await openWarning(end)).answer(focusField, Y)).toEqual({ endedNow: true });
  expect(ended).toEqual([{}]);
  expect(typed).toBe("");
});

test("with no trial running it asks nothing and ends nothing", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const { ended, end } = recordEnds();
  const result = await endTrialAfterWarning(dialog!, { isTrialActive: false, trialEndsAt: null }, end);
  await tui.renderFrames(2);
  expect(result).toBeNull();
  expect(ended).toEqual([]);
  expect(tui.frame()).not.toContain("Cancel Trial?");
});
