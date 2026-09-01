import { afterEach, expect, test } from "bun:test";
import { testRender } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { act } from "react";
import { Header } from "./header";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
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
