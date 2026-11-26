/** @jsxImportSource react */
import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, type AuthUser } from "../api-client";
import { WebDialogHostProvider } from "../renderers/dom/dialog-host";
import { createDomUiHost } from "../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../renderers/dom/input-host";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { noopRendererHost } from "../test-support/renderer-host";
import { blockExternalNetwork } from "../test-support/network-guard";
import { UiHostProvider } from "../ui";
import { HeardFromQuestionHost } from "./heard-from-question";
import { markHeardFromDue, takeHeardFromDue } from "./heard-from";

blockExternalNetwork();
const dom = createDomTestHarness({ withUi: false });

test("the desktop and web card keep the base AI answer when Skip closes the follow-up", async () => {
  const spies = [
    spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "synthetic-ai" } as AuthUser),
    spyOn(apiClient, "getHeardFrom").mockResolvedValue({ ask: true, settled: false }),
    spyOn(apiClient, "reportHeardFromShown").mockResolvedValue(undefined),
  ];
  const answer = spyOn(apiClient, "answerHeardFrom").mockResolvedValue(undefined);
  const skip = spyOn(apiClient, "skipHeardFrom").mockResolvedValue(undefined);
  try {
    const card = await dom.render(
      <UiHostProvider ui={createDomUiHost("browser")} renderer={noopRendererHost}>
        <WebInputHostProvider><WebDialogHostProvider><HeardFromQuestionHost /></WebDialogHostProvider></WebInputHostProvider>
      </UiHostProvider>,
    );
    await act(async () => markHeardFromDue("synthetic-ai"));
    const ai = [...card.querySelectorAll('[role="option"]')].find((row) => row.textContent?.trim() === "AI assistant");
    expect(ai).toBeDefined();
    await act(async () => ai?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(answer.mock.calls).toEqual([["ai_assistant", undefined]]);
    const input = card.querySelector<HTMLInputElement>('input[placeholder="Which AI, and what did you ask?"]');
    expect(input).not.toBeNull();
    expect(input?.maxLength).toBe(120);
    const skipButton = card.querySelector<HTMLButtonElement>('button[aria-label="Skip"]');
    expect(skipButton).not.toBeNull();
    await act(async () => skipButton?.click());
    expect(card.querySelector("input")).toBeNull();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(skip).not.toHaveBeenCalled();
  } finally {
    for (const spy of [...spies, answer, skip]) spy.mockRestore();
    takeHeardFromDue("synthetic-ai");
  }
});
