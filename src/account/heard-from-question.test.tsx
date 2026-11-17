import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type AuthUser } from "../api-client";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { blockExternalNetwork } from "../test-support/network-guard";
import { markHeardFromDue, takeHeardFromDue } from "./heard-from";
import { HeardFromQuestionHost } from "./heard-from-question";

blockExternalNetwork();
const tui = createOpenTuiTestHarness();
const TITLE = "Where did you hear about Gloom?";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  takeHeardFromDue("u1");
});

function signedInAs(ask: boolean) {
  const calls: string[] = [];
  spies.push(
    spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "u1", email: "ana@example.com", emailVerified: false } as AuthUser),
    spyOn(apiClient, "getHeardFrom").mockResolvedValue({ ask, settled: !ask }),
    spyOn(apiClient, "reportHeardFromShown").mockImplementation(async () => { calls.push("shown"); }),
    spyOn(apiClient, "answerHeardFrom").mockImplementation(async (answer, note) => { calls.push(note ? `${answer}: ${note}` : answer); }),
    spyOn(apiClient, "skipHeardFrom").mockImplementation(async () => { calls.push("skip"); }),
  );
  return calls;
}

async function press(...keys: Array<"down" | "enter" | "escape" | string>) {
  for (const key of keys) {
    await act(async () => {
      if (key === "down") tui.setup().mockInput.pressArrow("down");
      else if (key === "enter") tui.setup().mockInput.pressEnter();
      else if (key === "escape") tui.setup().mockInput.pressEscape();
      else await tui.setup().mockInput.typeText(key);
      await tui.setup().renderOnce();
    });
  }
}

describe("the question in the app", () => {
  test("asks the account just made, one key answers", async () => {
    const calls = signedInAs(true);
    await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
    await act(async () => markHeardFromDue("u1"));
    const frame = await tui.waitForFrameToContain(TITLE);
    expect(frame).toContain("Friend or colleague");
    await press("down", "enter");
    await tui.waitForFrameToExclude(TITLE);
    expect(calls).toEqual(["shown", "youtube"]);
  });

  test("Esc skips it for good", async () => {
    const calls = signedInAs(true);
    await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
    await act(async () => markHeardFromDue("u1"));
    await tui.waitForFrameToContain(TITLE);
    await press("escape");
    await tui.waitForFrameToExclude(TITLE);
    expect(calls).toEqual(["shown", "skip"]);
  });

  test("Other takes a short note", async () => {
    const calls = signedInAs(true);
    await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
    await act(async () => markHeardFromDue("u1"));
    await tui.waitForFrameToContain(TITLE);
    await press(...Array.from({ length: 9 }, () => "down"), "enter");
    await tui.waitForFrameToContain("Send");
    await press("a podcast", "enter");
    await tui.waitForFrameToExclude(TITLE);
    expect(calls).toEqual(["shown", "other: a podcast"]);
  });

  test("an account the service has settled is never shown it", async () => {
    const calls = signedInAs(false);
    await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
    await act(async () => markHeardFromDue("u1"));
    // The read has answered by now, and drew nothing.
    await act(async () => {
      await Bun.sleep(50);
      await tui.setup().renderOnce();
    });
    expect(apiClient.getHeardFrom).toHaveBeenCalledTimes(1);
    expect(tui.frame()).not.toContain(TITLE);
    expect(calls).toEqual([]);
  });
});
