import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type AuthUser } from "../api-client";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { blockExternalNetwork } from "../test-support/network-guard";
import { holdSetupCard } from "../components/onboarding/setup-cards";
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
    await press("down", "down", "down", "down", "down", "enter");
    await tui.waitForFrameToExclude(TITLE);
    expect(calls).toEqual(["shown", "reddit"]);
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
    // Esc in the note goes back to the list, it does not skip.
    await press("escape");
    await tui.waitForFrameToContain("Skip");
    expect(tui.frame()).toContain(TITLE);
    expect(calls).toEqual(["shown"]);
    await press("enter");
    await tui.waitForFrameToContain("Send");
    await press("a podcast", "enter");
    await tui.waitForFrameToExclude(TITLE);
    expect(calls).toEqual(["shown", "other: a podcast"]);
  });

  test("Instagram is kept at once, then asks which account or post", async () => {
    const calls = signedInAs(true);
    await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
    await act(async () => markHeardFromDue("u1"));
    await tui.waitForFrameToContain(TITLE);
    await press("down", "down", "down", "enter");
    await tui.waitForFrameToContain("Which account or post?");
    // Kept before a word of the note is written.
    expect(calls).toEqual(["shown", "instagram"]);
    await press("@la_bourse", "enter");
    await tui.waitForFrameToExclude(TITLE);
    expect(calls).toEqual(["shown", "instagram", "instagram: @la_bourse"]);
  });

  test("Esc from which account or post closes the card and keeps the answer", async () => {
    const calls = signedInAs(true);
    await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
    await act(async () => markHeardFromDue("u1"));
    await tui.waitForFrameToContain(TITLE);
    await press("down", "down", "enter");
    await tui.waitForFrameToContain("Which account or post?");
    await press("escape");
    await tui.waitForFrameToExclude(TITLE);
    expect(calls).toEqual(["shown", "tiktok"]);
  });

  for (const action of ["enter", "escape"]) {
    test(`AI is kept at once; ${action} ${action === "enter" ? "saves the note" : "discards the draft"}`, async () => {
      const calls = signedInAs(true);
      await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
      await act(async () => markHeardFromDue("u1"));
      await tui.waitForFrameToContain(TITLE);
      await press(...Array.from({ length: 6 }, () => "down"), "enter");
      await tui.waitForFrameToContain("Which AI, and what did you ask?");
      expect(calls).toEqual(["shown", "ai_assistant"]);
      const note = "Synthetic AI: explain a bond ladder";
      await press(note, action);
      await tui.waitForFrameToExclude(TITLE);
      expect(calls).toEqual(action === "enter" ? ["shown", "ai_assistant", `ai_assistant: ${note}`] : ["shown", "ai_assistant"]);
    });
  }

  test("waits for the card already up (the companies to follow) to close", async () => {
    const calls = signedInAs(true);
    const release = holdSetupCard();
    await tui.render(<HeardFromQuestionHost />, { width: 100, height: 40 });
    await act(async () => markHeardFromDue("u1"));
    await act(async () => {
      await Bun.sleep(50);
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).not.toContain(TITLE);
    expect(calls).toEqual([]);
    await act(async () => release());
    await tui.waitForFrameToContain(TITLE);
    expect(calls).toEqual(["shown"]);
    await press("escape");
    await tui.waitForFrameToExclude(TITLE);
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
