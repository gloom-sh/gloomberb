import { afterEach, expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { act } from "react";
import { Header } from "./header";
import { publishCommandBarPrompt } from "../command-bar/panel/prompt-binding";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  publishCommandBarPrompt(null);
});

test("opens the command bar by clicking the header prompt", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-header-test"));
  const actions: Array<{ type: string; open?: boolean; query?: string }> = [];
  await tui.render(
    <AppContext value={createStaticAppStore(state, (action) => actions.push(action as { type: string }))}>
      <Header />
    </AppContext>,
    { width: 120, height: 1 },
  );

  await tui.setup().renderOnce();
  const promptX = tui.frame().indexOf(">");
  expect(promptX).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await tui.setup().mockMouse.click(promptX + 2, 0);
    await tui.setup().renderOnce();
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
  await tui.render(
    <AppContext value={createStaticAppStore(state)}>
      <Header />
    </AppContext>,
    { width: 120, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).not.toContain("Search or run a command");

  await act(async () => {
    publishCommandBarPrompt({
      screenKey: "root:Commands",
      query: "QQ",
      placeholder: "Command or plain English…",
      ghostSuffix: " AAPL",
      onQueryChange: (query) => typed.push(query),
    });
    await tui.setup().renderOnce();
  });
  expect(tui.frame()).toContain("QQ AAPL");

  await act(async () => {
    await tui.setup().mockInput.typeText("x");
    await tui.setup().renderOnce();
  });
  expect(typed).toEqual(["QQx"]);

  await act(async () => {
    publishCommandBarPrompt(null);
    await tui.setup().renderOnce();
  });
  expect(tui.frame()).not.toContain("QQ");
});

/**
 * A downloaded desktop update waits for the user: the header names it and
 * offers Restart, which is clickable. The terminal binary is already swapped
 * in, so it only says to restart and has nothing to press.
 */
test("offers a clickable Restart for a downloaded desktop update, and only text for a terminal one", async () => {
  const config = createDefaultConfig("/tmp/gloomberb-header-test");
  const desktop = { ...createInitialState(config), updateProgress: { phase: "ready" as const, canRestart: true } };
  let restarts = 0;
  await tui.render(
    <AppContext value={createStaticAppStore(desktop)}>
      <Header onRestartForUpdate={() => { restarts += 1; }} />
    </AppContext>,
    { width: 120, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).toContain("Update ready");
  const restartX = tui.frame().indexOf("Restart");
  expect(restartX).toBeGreaterThanOrEqual(0);
  // The key that restarts is advertised beside the button.
  expect(tui.frame()).toMatch(/Restart\s+u/i);

  await act(async () => {
    await tui.setup().mockMouse.click(restartX + 2, 0);
    await tui.setup().renderOnce();
  });
  expect(restarts).toBe(1);

  const terminal = { ...createInitialState(config), updateProgress: { phase: "ready" as const } };
  await tui.render(
    <AppContext value={createStaticAppStore(terminal)}>
      <Header onRestartForUpdate={() => { restarts += 1; }} />
    </AppContext>,
    { width: 120, height: 1 },
  );
  await tui.setup().renderOnce();
  expect(tui.frame()).toContain("Update ready, restart to apply");
  expect(tui.frame()).not.toContain("Restart ");
});
