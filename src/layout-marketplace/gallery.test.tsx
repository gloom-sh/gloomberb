import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import { AppContext, createInitialState, type AppAction } from "../state/app/context";
import { cloneLayout, createDefaultConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import type { PluginRegistry } from "../plugins/registry";
import { LayoutMarketplaceGallery } from "./gallery";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  await act(async () => {
    testSetup?.renderer.destroy();
    testSetup = undefined;
  });
});

function paneDef(id: string, name: string, icon: string): PaneDef {
  return { id, name, icon, component: () => null, defaultPosition: "left" };
}

const panes = new Map<string, PaneDef>([
  ["portfolio-list", paneDef("portfolio-list", "Portfolio", "P")],
  ["ticker-research", paneDef("ticker-research", "Ticker Research", "T")],
  ["chat", paneDef("chat", "Chat", "M")],
]);

const registry = {
  panes,
  notify: () => {},
} as unknown as PluginRegistry;

async function renderGallery() {
  const config = createDefaultConfig("/tmp/gloomberb-layout-gallery-test");
  config.layouts = [
    { name: "Default", layout: cloneLayout(config.layout) },
    { name: "Research Desk", layout: cloneLayout(config.layout) },
  ];
  const state = createInitialState(config);
  const actions: AppAction[] = [];
  let closed = false;

  testSetup = await testRender(
    <AppContext value={{ state, dispatch: (action) => actions.push(action) }}>
      <LayoutMarketplaceGallery pluginRegistry={registry} onClose={() => { closed = true; }} />
    </AppContext>,
    { width: 100, height: 24 },
  );
  await testSetup.renderOnce();
  return { actions, isClosed: () => closed };
}

test("lists owned layouts before Discover and details the selected layout", async () => {
  await renderGallery();

  const frame = testSetup!.captureCharFrame();
  expect(frame).toContain("YOUR LAYOUTS (2)");
  expect(frame).toContain("Default");
  expect(frame).toContain("Research Desk");
  expect(frame.indexOf("YOUR LAYOUTS")).toBeLessThan(frame.indexOf("DISCOVER"));
  // Signed out keeps Discover gated without touching the network.
  expect(frame).toContain("Log in to browse community layouts");
  // Details name real panes instead of drawing empty preview boxes.
  expect(frame).toContain("Portfolio");
  expect(frame).toContain("Ticker Research");
  expect(frame).toContain("3 docked");
});

test("j/k move the selection and Enter switches to the layout and closes", async () => {
  const { actions, isClosed } = await renderGallery();

  await act(async () => {
    testSetup!.mockInput.pressKey("j");
    await testSetup!.renderOnce();
  });
  await act(async () => {
    testSetup!.mockInput.pressEnter();
    await testSetup!.renderOnce();
  });

  expect(actions).toContainEqual({ type: "SWITCH_LAYOUT", index: 1 });
  expect(isClosed()).toBe(true);
});
