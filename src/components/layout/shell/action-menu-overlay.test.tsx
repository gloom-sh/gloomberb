import { describe, expect, test } from "bun:test";
import { act } from "react";
import { planUiCall, UiCallRefusal } from "../../../plugins/builtin/cloud/terminal-relay/policy";
import { createRemoteUiRegistry, RemoteUiRegistryProvider, RemoteUiScope } from "../../../remote/semantic-tree";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { Menu } from "../../ui/menu";
import { EMPTY_FOOTER } from "../pane/footer/model";
import { ShellActionMenuOverlay } from "./action-menu-overlay";
import { menuItemsForFallback, paneFooterMenuItems } from "./menu";

const tui = createOpenTuiTestHarness();

/** A pane's footer while Ask Gloom asks: Approve is its prompt's, Refresh is not. */
function paneMenuEntries(withPrompt: boolean) {
  const footer = {
    ...EMPTY_FOOTER,
    hints: [
      { id: "refresh", key: "r", label: "efresh", title: "Refresh", onPress: () => {} },
      ...(withPrompt ? [{ id: "approve", key: "y", label: "es approve", title: "Approve", remoteScope: "askg-prompt", onPress: () => {} }] : []),
    ],
  };
  return menuItemsForFallback(paneFooterMenuItems(footer), "terminal");
}

async function renderOverlay(withPrompt: boolean) {
  const registry = createRemoteUiRegistry();
  const items = paneMenuEntries(withPrompt);
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <ShellActionMenuOverlay
        menuState={{ paneId: "chart:1", x: 0, y: 0, width: 24, items }}
        hoveredMenuItemId={null}
        onClose={() => {}}
        onHoverItem={() => {}}
      />
    </RemoteUiRegistryProvider>,
    { width: 30, height: 8 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
  });
  return { items, nodes: registry.snapshot() };
}

const press = (nodes: ReturnType<ReturnType<typeof createRemoteUiRegistry>["snapshot"]>, nodeId: string) => planUiCall(
  "ui.invoke",
  { nodeId, action: "press" },
  { read: async () => nodes, promptOpen: false },
);

describe("the pane menu while a prompt's answers are in it", () => {
  test("is that prompt's as a whole, so no assistant's UI call chooses from it", async () => {
    const { items, nodes } = await renderOverlay(true);
    expect(items.find((item) => item.id === "pane-hint:approve")?.remoteScope).toBe("askg-prompt");
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((node) => node.metadata?.scope === "askg-prompt")).toBe(true);
    for (const node of nodes) await expect(press(nodes, node.id)).rejects.toBeInstanceOf(UiCallRefusal);

    // Without one, a row is a control like any other, asked about before it runs.
    const plain = await renderOverlay(false);
    expect(plain.nodes.some((node) => node.metadata?.scope)).toBe(false);
    expect((await press(plain.nodes, plain.nodes.at(-1)!.id))?.confirm).not.toBeNull();
  });

  test("the desktop's menu takes the prompt's scope from around it", async () => {
    const registry = createRemoteUiRegistry();
    await tui.render(
      <RemoteUiRegistryProvider registry={registry}>
        <RemoteUiScope scope="askg-prompt">
          <Menu label="Pane" items={[{ id: "pane-hint:approve", label: "Approve" }]} onSelect={() => {}} />
        </RemoteUiScope>
      </RemoteUiRegistryProvider>,
      { width: 30, height: 6 },
    );
    const menu = registry.snapshot().find((node) => node.role === "menu")!;
    expect(menu.metadata?.scope).toBe("askg-prompt");
    await expect(planUiCall(
      "ui.invoke",
      { nodeId: menu.id, action: "select", input: "pane-hint:approve" },
      { read: async () => registry.snapshot(), promptOpen: false },
    )).rejects.toBeInstanceOf(UiCallRefusal);
  });
});
