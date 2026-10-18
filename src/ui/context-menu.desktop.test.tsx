import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { createDomUiHost } from "../renderers/dom/dom-ui-host";
import { noopRendererHost } from "../test-support/renderer-host";
import { UiHostProvider } from "./host";
import { ContextMenuProvider } from "./context-menu";
import { WebTabs } from "../renderers/dom/host/tabs";

const { render, window } = createDomTestHarness({ withUi: false });

test("a tab strip's add and close marks keep the strip's menu instead of the app's", async () => {
  const shown: unknown[] = [];
  const renderer = { ...noopRendererHost, showContextMenu: async (items: unknown) => { shown.push(items); return true; } };
  const container = await render(
    <UiHostProvider ui={createDomUiHost("linux", { nativeContextMenu: true })} renderer={renderer}>
      <ContextMenuProvider pluginRegistry={null}>
        <WebTabs tabs={[{ label: "One", value: "one", onClose: () => {} }]} activeValue="one" onSelect={() => {}} onAdd={() => {}} closeMode="always" palette={{} as never} />
        <div data-testid="plain">Plain</div>
      </ContextMenuProvider>
    </UiHostProvider>,
  );
  const rightClick = async (selector: string) => {
    await act(async () => {
      container.querySelector(selector)!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }) as unknown as Event);
    });
  };
  await rightClick('[data-gloom-role="tab-add"]');
  await rightClick('[data-gloom-role="tab-close"]');
  expect(shown).toHaveLength(0);
  await rightClick('[data-testid="plain"]');
  expect(shown).toHaveLength(1);
});
