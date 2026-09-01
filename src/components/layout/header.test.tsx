import { afterEach, expect, test } from "bun:test";
import { testRender } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { act } from "react";
import { Header } from "./header";
import { publishCommandBarPrompt } from "../command-bar/panel/prompt-binding";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  publishCommandBarPrompt(null);
  testSetup?.renderer.destroy();
  testSetup = undefined;
});

test("opens the command bar by clicking the header prompt", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-header-test"));
  const actions: Array<{ type: string; open?: boolean; query?: string }> = [];
  testSetup = await testRender(
    <AppContext value={{ state, dispatch: (action) => actions.push(action as { type: string }) }}>
      <Header />
    </AppContext>,
    { width: 120, height: 1 },
  );

  await testSetup.renderOnce();
  const promptX = testSetup.captureCharFrame().indexOf(">");
  expect(promptX).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await testSetup!.mockMouse.click(promptX + 2, 0);
    await testSetup!.renderOnce();
  });

  expect(actions).toContainEqual({ type: "SET_COMMAND_BAR", open: true, query: "" });
});

/**
 * While the bar is open the header prompt is its input: what the panel
 * publishes is what the user types into, and a screen without a binding (a
 * workflow with its own fields) must not put a focused input in the header.
 */
test("hosts the command bar input while a list screen is published", async () => {
  const state = {
    ...createInitialState(createDefaultConfig("/tmp/gloomberb-header-test")),
    commandBarOpen: true,
  };
  const typed: string[] = [];
  testSetup = await testRender(
    <AppContext value={{ state, dispatch: () => {} }}>
      <Header />
    </AppContext>,
    { width: 120, height: 1 },
  );
  await testSetup.renderOnce();
  expect(testSetup.captureCharFrame()).not.toContain("Search or run a command");

  await act(async () => {
    publishCommandBarPrompt({
      screenKey: "root:Commands",
      query: "QQ",
      placeholder: "Command or plain English…",
      ghostSuffix: " AAPL",
      onQueryChange: (query) => typed.push(query),
    });
    await testSetup!.renderOnce();
  });
  expect(testSetup.captureCharFrame()).toContain("QQ AAPL");

  await act(async () => {
    await testSetup!.mockInput.typeText("x");
    await testSetup!.renderOnce();
  });
  expect(typed).toEqual(["QQx"]);

  await act(async () => {
    publishCommandBarPrompt(null);
    await testSetup!.renderOnce();
  });
  expect(testSetup.captureCharFrame()).not.toContain("QQ");
});
