import type { ScrollBoxRenderable } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import { buildASKGToolManifests } from "../askg/manifest";
import { createASKGToolExecutor } from "../askg/executor";
import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import { DataTable } from "../../../../components/ui/data-table";
import { ListView } from "../../../../components/ui/list-view";
import { Menu } from "../../../../components/ui/menu";
import type { MarketContext } from "../../../../cli/types";
import type { PluginRegistry } from "../../../registry";
import { createRemoteResources } from "../../../../remote/resources";
import { createRemoteUiRegistry, RemoteUiPaneScope, RemoteUiRegistryProvider, type RemoteUiRegistry } from "../../../../remote/semantic-tree";
import type { RemoteUiNodeSnapshot } from "../../../../remote/types";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../../state/app/context";
import { createStaticAppStore } from "../../../../test-support/app-store";
import { createTestPaneConfig } from "../../../../test-support/pane";
import { Box } from "../../../../ui";
import { planUiCall, type UiCallContext } from "./policy";

const tui = createOpenTuiTestHarness();

const CHANGED = "What the call pointed at changed while the person decided, so it did not run. Read the state again and retry.";

describe("a UI call that asks nothing", () => {
  test("does not run once the screen turned it into one that runs something", async () => {
    let nodes: RemoteUiNodeSnapshot[] = [];
    const context: UiCallContext = { read: async () => nodes, promptOpen: false };
    const menu = (selection: string): RemoteUiNodeSnapshot => ({
      id: "ui:1",
      role: "menu",
      label: "Layout",
      actions: ["select"],
      metadata: { selection, items: [{ id: "delete", label: "Delete Layout" }] },
    });
    const choose = { role: "menu", label: "Layout", action: "select", input: "delete" };

    // Not on screen when the call came: nothing to ask about yet.
    const missing = await planUiCall("ui.invokeMatching", choose, context);
    expect(missing?.confirm).toBeNull();
    nodes = [menu("none")];
    expect(await missing!.recheck(false)).toBe(CHANGED);

    // A select field's menu only picks a value; a plain menu in its place runs the item.
    nodes = [menu("single")];
    const field = await planUiCall("ui.invoke", { nodeId: "ui:1", action: "select", input: "delete" }, context);
    expect(field?.confirm).toBeNull();
    expect(await field!.recheck(false)).toBeNull();
    nodes = [menu("none")];
    expect(await field!.recheck(false)).toBe(CHANGED);
  });
});

type Row = { key: string; token: string; note: string };

function Table({ rows, onActivate }: { rows: Row[]; onActivate: (row: Row) => void }) {
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  return (
    <DataTable
      columns={[{ id: "token", label: "Token", width: 8, align: "left" }, { id: "note", label: "Note", width: 30, align: "left" }]}
      items={rows}
      sortColumnId="token"
      sortDirection="asc"
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      syncHeaderScroll={() => {}}
      onBodyScrollActivity={() => {}}
      getItemKey={(row) => row.key}
      isSelected={() => false}
      onSelect={() => {}}
      onActivate={onActivate}
      renderCell={(row, column) => ({ text: column.id === "token" ? row.token : row.note })}
      emptyStateTitle="No rows."
    />
  );
}

/**
 * A plain menu, a list and a table drawn in one pane, with the resources an
 * assistant reads them through (resources.ts), as the app serves them.
 */
async function renderControls(credential: string) {
  const registry = createRemoteUiRegistry();
  const ran: string[] = [];
  const config = createTestPaneConfig("/tmp/gloomberb-relay-policy", { instanceId: "crypto:1", paneId: "crypto-board", title: "Crypto Board" });
  const state = createInitialState({ ...config, pluginConfig: { "gloom-coins": { apiKey: credential } } });
  const pluginRegistry = { panes: new Map([["crypto-board", { id: "crypto-board", name: "Crypto" }]]) } as unknown as PluginRegistry;
  const { getResource } = createRemoteResources({
    dispatch: () => {},
    getState: () => state,
    pluginRegistry,
    uiRegistry: registry,
    isDialogOpen: () => false,
  });
  // An id that is another item's label, so a match on either would pick the wrong one.
  const menuItems = [{ id: "archive", label: "Delete" }, { id: "Delete", label: "Archive" }];
  const listItems = [{ id: "b", label: "a" }, { id: "a", label: "b" }];
  const rows: Row[] = [
    { key: "eth", token: "ETH", note: "gas token" },
    { key: "sol", token: "SOL", note: `feed ${credential}` },
  ];
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <AppContext value={createStaticAppStore(state)}>
        <RemoteUiPaneScope paneId="crypto:1">
          <Box flexDirection="column">
            <Menu label="Actions" items={menuItems} onSelect={(id) => ran.push(`menu:${menuItems.find((item) => item.id === id)?.label}`)} />
            <ListView
              items={listItems}
              selectedIndex={0}
              remoteLabel="Results"
              height={2}
              onActivate={(item) => ran.push(`list:${item.label}`)}
            />
            <Table rows={rows} onActivate={(row) => ran.push(`table:${row.token}`)} />
          </Box>
        </RemoteUiPaneScope>
      </AppContext>
    </RemoteUiRegistryProvider>,
    { width: 60, height: 14 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
  });
  const node = (role: string) => registry.snapshot().find((entry) => entry.role === role)!;
  return { registry, getResource, ran, node, state };
}

/** What the call is asked as, then what the control did with the same input. */
async function askedThenRan(
  { registry, getResource, ran }: { registry: RemoteUiRegistry; getResource: (resource: string) => unknown; ran: string[] },
  nodeId: string,
  action: string,
  input: unknown,
) {
  const plan = await planUiCall("ui.invoke", { nodeId, action, input: input as never }, { read: async (resource) => getResource(resource), promptOpen: false });
  ran.length = 0;
  await registry.invoke(nodeId, action, input);
  return { asked: plan?.confirm?.title, ran: ran.slice() };
}

describe("the item a UI call is asked about", () => {
  test("is the one the control runs: a menu by id, a list by index, id or label, a table row by index or key", async () => {
    const controls = await renderControls("coins-key-0123456789");
    const menu = controls.node("menu").id;
    const list = controls.node("list").id;
    const table = controls.node("table").id;

    expect(await askedThenRan(controls, menu, "select", "Delete")).toEqual({ asked: "Choose \"Archive\" from \"Actions\" (menu)", ran: ["menu:Archive"] });
    expect(await askedThenRan(controls, menu, "select", { id: "archive" })).toEqual({ asked: "Choose \"Delete\" from \"Actions\" (menu)", ran: ["menu:Delete"] });
    // A menu picks by id alone: a label or an index runs nothing, and names nothing.
    expect(await askedThenRan(controls, menu, "select", { label: "Delete" })).toEqual({ asked: "Run \"select\" on \"Actions\" (menu)", ran: [] });
    expect(await askedThenRan(controls, menu, "select", 0)).toEqual({ asked: "Run \"select\" on \"Actions\" (menu)", ran: [] });

    expect(await askedThenRan(controls, list, "activate", "a")).toEqual({ asked: "Choose \"a\" in \"Results\" (list)", ran: ["list:a"] });
    expect(await askedThenRan(controls, list, "activate", { id: "a" })).toEqual({ asked: "Choose \"b\" in \"Results\" (list)", ran: ["list:b"] });
    expect(await askedThenRan(controls, list, "activate", { index: 1 })).toEqual({ asked: "Choose \"b\" in \"Results\" (list)", ran: ["list:b"] });
    expect(await askedThenRan(controls, list, "activate", { key: "a" })).toEqual({ asked: "Run \"activate\" on \"Results\" (list)", ran: [] });

    expect(await askedThenRan(controls, table, "activateRow", { id: "sol" })).toEqual({ asked: "Choose \"SOL\" in \"Data table\" (table)", ran: ["table:SOL"] });
    expect(await askedThenRan(controls, table, "activateRow", 0)).toEqual({ asked: "Choose \"ETH\" in \"Data table\" (table)", ran: ["table:ETH"] });
    expect(await askedThenRan(controls, table, "activateRow", { label: "ETH" })).toEqual({ asked: "Run \"activateRow\" on \"Data table\" (table)", ran: [] });
  });

  test("a table's rows come with its pane's title from ui://node, and Ask Gloom reads them without a stored credential", async () => {
    const credential = "coins-key-0123456789";
    const controls = await renderControls(credential);
    const table = controls.node("table");

    // The tree leaves the rows out for size; the one node's read has them, and the pane's title.
    expect(table.metadata?.rows).toBeUndefined();
    const detail = controls.getResource(`ui://node/${encodeURIComponent(table.id)}`) as RemoteUiNodeSnapshot & { paneTitle?: string };
    expect(detail.paneTitle).toBe("Crypto Board");
    expect(detail.metadata?.rows).toEqual([
      { key: "eth", selected: false, cells: [{ columnId: "token", columnLabel: "Token", text: "ETH" }, { columnId: "note", columnLabel: "Note", text: "gas token" }] },
      { key: "sol", selected: false, cells: [{ columnId: "token", columnLabel: "Token", text: "SOL" }, { columnId: "note", columnLabel: "Note", text: `feed ${credential}` }] },
    ]);
    expect(() => controls.getResource("ui://node/ui%3Agone")).toThrow("No UI node \"ui:gone\" is on screen.");

    // Through Ask Gloom: the Token column reads as it shows, the stored key does not.
    const catalog: PaneFunctionCatalog = { panes: new Map(), paneTemplates: new Map(), destroy() {} };
    const tools = buildASKGToolManifests(catalog).tools;
    const getResourceTool = tools.find((tool) => tool.name === "app.get_resource")!;
    const executor = createASKGToolExecutor({
      manifests: tools,
      registry: catalog,
      context: { config: controls.state.config } as MarketContext,
      remoteHandler: async (request) => (request.type === "get" ? { ok: true, data: controls.getResource(request.resource) } : { ok: false, error: { code: "remote_error", message: "read only" } }),
    });
    const result = await executor.execute({
      seq: 1,
      type: "tool-call",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: getResourceTool.name,
      args: { resource: `ui://node/${table.id}` },
      writeTier: "read",
      requiresConfirmation: false,
      preview: null,
      timeoutMs: getResourceTool.timeoutMs,
      expiresAt: new Date(Date.now() + getResourceTool.timeoutMs).toISOString(),
    });
    expect(result.status).toBe("ok");
    const read = result.result as { paneTitle: string; metadata: { sortColumnId: string; rows: Array<{ cells: Array<{ text: string }> }> } };
    expect(read.paneTitle).toBe("Crypto Board");
    expect(read.metadata.sortColumnId).toBe("token");
    expect(read.metadata.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([["ETH", "gas token"], ["SOL", "feed [redacted]"]]);
    expect(JSON.stringify(result)).not.toContain(credential);
  });
});
