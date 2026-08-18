import { afterEach, expect, test } from "bun:test";
import { testRender } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { VERSION } from "../../version";
import { act } from "react";
import { Header } from "./header";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(() => {
  testSetup?.renderer.destroy();
  testSetup = undefined;
});

test("opens the current version changelog from the header", async () => {
  let openedVersion = "";
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-header-test"));
  testSetup = await testRender(
    <AppContext value={{ state, dispatch: () => {} }}>
      <Header onOpenChangelog={(version) => { openedVersion = version; }} />
    </AppContext>,
    { width: 100, height: 1 },
  );

  await testSetup.renderOnce();
  const versionX = testSetup.captureCharFrame().indexOf(`v${VERSION}`);
  expect(versionX).toBeGreaterThanOrEqual(0);

  await act(async () => {
    await testSetup!.mockMouse.click(versionX + 1, 0);
    await testSetup!.renderOnce();
  });
  expect(openedVersion).toBe(VERSION);
});
