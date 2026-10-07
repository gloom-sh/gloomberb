import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { AppContext, createInitialState, type AppAction } from "../state/app/context";
import { createStaticAppStore } from "../test-support/app-store";
import { cloneLayout, createDefaultConfig } from "../types/config";
import { Box } from "../ui";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "../components/layout/pane/footer";
import type { PluginRegistry } from "../plugins/registry";
import { LayoutMarketplaceGallery } from "./gallery";
import { testDockedLayout, testPanes as panes } from "./test-fixture";

const tui = createOpenTuiTestHarness();

const registry = {
  panes,
  notify: () => {},
} as unknown as PluginRegistry;

async function renderGallery() {
  const config = createDefaultConfig("/tmp/gloomberb-layout-gallery-test");
  config.layout = testDockedLayout();
  config.layouts = [
    { name: "Default", layout: cloneLayout(config.layout) },
    { name: "Research Desk", layout: cloneLayout(config.layout) },
  ];
  const state = createInitialState(config);
  const actions: AppAction[] = [];
  let closed = false;

  await tui.render(
    <AppContext value={createStaticAppStore(state, (action) => actions.push(action))}>
      <PaneFooterProvider>
        {(footer) => (
          <Box width={100} height={24} flexDirection="column">
            <Box width={100} height={23}>
              <LayoutMarketplaceGallery
                pluginRegistry={registry}
                width={100}
                height={23}
                onClose={() => { closed = true; }}
              />
            </Box>
            <PaneFooterBar footer={footer} focused width={100} />
            <PaneFooterKeys paneId="layout-marketplace" footer={footer} focused />
          </Box>
        )}
      </PaneFooterProvider>
    </AppContext>,
    { width: 100, height: 24 },
  );
  await tui.setup().renderOnce();
  return { actions, isClosed: () => closed };
}

test("lists owned layouts before Discover and details the selected layout", async () => {
  await renderGallery();

  const frame = tui.frame();
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

  const searchLine = frame.split("\n").find((line) => line.includes("Search layouts and panes"));
  expect(searchLine?.startsWith("/ Search layouts and panes")).toBe(true);
  expect(frame).toContain("[/]search");
  expect(frame).toContain("[n]ew");
  expect(frame).toContain("[o]pen");
  expect(frame).toContain("[e] rename");
  expect(frame).toContain("[c]opy");
  expect(frame).toContain("[d]elete");
  expect(frame).toContain("[p]ublish");
});

test("search Enter returns to the list before activating the filtered layout", async () => {
  const { actions, isClosed } = await renderGallery();

  await act(async () => {
    tui.setup().mockInput.pressKey("/");
    await tui.setup().renderOnce();
  });
  await act(async () => {
    await tui.setup().mockInput.typeText("Research");
    tui.setup().mockInput.pressEnter();
    await tui.setup().renderOnce();
  });

  expect(isClosed()).toBe(false);
  expect(actions.some((action) => action.type === "SWITCH_LAYOUT")).toBe(false);
  expect(tui.frame()).toContain("/ Research");

  await act(async () => {
    tui.setup().mockInput.pressEnter();
    await tui.setup().renderOnce();
  });

  expect(actions).toContainEqual({ type: "SWITCH_LAYOUT", index: 1 });
  expect(isClosed()).toBe(true);
});

test("j/k move the selection and Enter switches to the layout and closes", async () => {
  const { actions, isClosed } = await renderGallery();

  await act(async () => {
    tui.setup().mockInput.pressKey("j");
    await tui.setup().renderOnce();
  });
  await act(async () => {
    tui.setup().mockInput.pressEnter();
    await tui.setup().renderOnce();
  });

  expect(actions).toContainEqual({ type: "SWITCH_LAYOUT", index: 1 });
  expect(isClosed()).toBe(true);
});
