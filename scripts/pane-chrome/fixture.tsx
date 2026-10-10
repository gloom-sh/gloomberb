/** @jsxImportSource react */
/**
 * The page the pane chrome checks drive: the real desktop shell (dock,
 * floating panes, pane headers, title-bar tabs, dividers) in the real DOM
 * host with the desktop app's own UI and renderer hosts, over a fixed layout
 * of stand-in panes. Nothing here fetches: the Electrobun backend is the CLI
 * screenshot stub, and the native window bridge is a recorder the page
 * script sets up before this runs (see page.ts).
 *
 * The scenario comes from the query string: `?scenario=docked`, `floating`,
 * `detached` (a popped-out window; `&platform=win32` adds Windows caption
 * buttons) or `perf` (a denser layout for the frame budget).
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DataTableView } from "../../src/components/data-table/view";
import { DetachedPaneShell } from "../../src/components/layout/detached-pane-shell";
import { usePaneTabs } from "../../src/components/layout/pane/pane-tabs";
import { Shell } from "../../src/components/layout/shell";
import type { PluginRegistry } from "../../src/plugins/registry";
import { DomHostProviders } from "../../src/renderers/dom/dom-host-providers";
import { createWebUiHost, webRendererHost } from "../../src/renderers/electrobun/view/ui-host";
import { AppProvider } from "../../src/state/app/context";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "../../src/theme/font-scale";
import { cloneLayout, createDefaultConfig, type DockLayoutNode, type LayoutConfig } from "../../src/types/config";
import type { DesktopWindowBridge } from "../../src/types/desktop-window";
import type { PaneProps } from "../../src/types/plugin";
import { Box, Text } from "../../src/ui";

declare global {
  interface Window {
    __paneChrome: {
      ready: boolean;
      cell: { width: number; height: number };
      registry: PluginRegistry;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get("scenario") ?? "docked";
const platform = params.get("platform") ?? "darwin";

function PlainPane({ paneId }: PaneProps) {
  return <Text>{`Body of ${paneId}`}</Text>;
}

const TAB_LABELS: Record<string, string> = { one: "First", two: "Second", three: "Third" };

/** Three title-bar tabs that select and reorder, like a research pane's. */
function TabsPane(_props: PaneProps) {
  const [order, setOrder] = useState(["one", "two", "three"]);
  const [active, setActive] = useState("one");
  const { strip } = usePaneTabs({
    tabs: order.map((value) => ({ value, label: TAB_LABELS[value]! })),
    activeValue: active,
    onSelect: setActive,
    onReorder: (from, to) => setOrder((current) => {
      const next = current.filter((value) => value !== from);
      next.splice(current.indexOf(to), 0, from);
      return next;
    }),
  });
  return (
    <Box flexDirection="column">
      {strip}
      <Text>{`Showing ${TAB_LABELS[active]}`}</Text>
    </Box>
  );
}

/** Throws on every render, so the chrome shows the pane's failure card. */
function BrokenPane(_props: PaneProps): never {
  throw new Error("fixture pane failed to render");
}

const TABLE_COLUMNS = ["Symbol", "Last", "Chg", "Chg %", "Volume", "Mkt cap"].map((label, index) => ({
  id: `c${index}`, label, width: index === 0 ? 10 : 9, align: index === 0 ? "left" as const : "right" as const,
}));
const TABLE_ROWS = Array.from({ length: 120 }, (_, row) => row);

/**
 * The kit's table over 120 rows, as most panes draw: a scrolling, virtualized
 * body under a header. Enough DOM that a page-wide restyle, relayout or
 * relayering shows up in the frame budget.
 */
function TablePane({ paneId, focused }: PaneProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <DataTableView<number>
      focused={focused}
      selection={{ kind: "id", selectedId, getId: String, onChange: setSelectedId }}
      columns={TABLE_COLUMNS}
      items={TABLE_ROWS}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={String}
      emptyStateTitle="No rows"
      renderCell={(row, column) => {
        const value = ((row * 7919 + Number(column.id.slice(1)) * 104729 + paneId.length) % 99991) / 100;
        return { text: column.id === "c0" ? `T${row}` : value.toFixed(2) };
      }}
    />
  );
}

const PANES = {
  plain: { name: "Plain", component: PlainPane },
  tabs: { name: "Tabbed", component: TabsPane },
  broken: { name: "Broken", component: BrokenPane },
  table: { name: "Table", component: TablePane },
};

function registry(): PluginRegistry {
  return {
    panes: new Map(Object.entries(PANES).map(([id, pane]) => [id, { id, defaultPosition: "right", ...pane }])),
    paneTemplates: new Map(),
    commands: new Map(),
    tickerActions: new Map(),
    brokers: new Map(),
    allPlugins: new Map(),
    getEnabledTickerActions: () => [],
    getPluginPaneIds: () => [],
    getPluginPaneTemplateIds: () => [],
    getContextMenuItems: () => [],
    resolvePaneQuickSettings: () => [],
    hasPaneSettings: () => false,
    notify: () => {},
    openPaneSettings: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    hidePane: () => {},
    openWindowMode: () => {},
    updateLayout: () => {},
    // The shell binds its actions here as it mounts (togglePaneFullscreen among them).
    bindHost(actions: object) {
      Object.assign(this, actions);
      return () => {};
    },
  } as unknown as PluginRegistry;
}

const leaf = (instanceId: string): DockLayoutNode => ({ kind: "pane", instanceId });
/** Side by side, equal widths. */
const row = (ids: string[]): DockLayoutNode => ids.length === 1 ? leaf(ids[0]!) : {
  kind: "split", axis: "horizontal", ratio: 1 / ids.length, first: leaf(ids[0]!), second: row(ids.slice(1)),
};
const instance = (instanceId: string) => ({ instanceId, paneId: instanceId.split(":")[0]!, binding: { kind: "none" as const } });

/**
 * Docked: plain:a | tabs:a | plain:b over broken:a | plain:c. `floating` adds
 * plain:float over the lower right; `detached` pops tabs:a out instead.
 */
function chromeLayout(): LayoutConfig {
  const ids = ["plain:a", "tabs:a", "plain:b", "broken:a", "plain:c"];
  const layout: LayoutConfig = {
    dockRoot: { kind: "split", axis: "vertical", ratio: 0.5, first: row(ids.slice(0, 3)), second: row(ids.slice(3)) },
    instances: ids.map(instance),
    floating: [],
    detached: [],
  };
  if (scenario === "floating") {
    layout.instances.push(instance("plain:float"));
    layout.floating.push({ instanceId: "plain:float", x: 100, y: 30, width: 56, height: 12, zIndex: 60 });
  }
  if (scenario === "detached") {
    layout.detached.push({ instanceId: "tabs:a", x: 0, y: 0, width: 80, height: 24 });
  }
  return layout;
}

/** Three rows of three table panes, with a floating table over the middle. */
function perfLayout(): LayoutConfig {
  const ids = Array.from({ length: 9 }, (_, index) => `table:${index + 1}`);
  return {
    dockRoot: {
      kind: "split", axis: "vertical", ratio: 1 / 3, first: row(ids.slice(0, 3)),
      second: { kind: "split", axis: "vertical", ratio: 0.5, first: row(ids.slice(3, 6)), second: row(ids.slice(6)) },
    },
    instances: [...ids, "table:float"].map(instance),
    floating: [{ instanceId: "table:float", x: 60, y: 14, width: 70, height: 20, zIndex: 60 }],
    detached: [],
  };
}

function config() {
  const base = createDefaultConfig("/pane-chrome-fixture");
  const layout = scenario === "perf" ? perfLayout() : chromeLayout();
  return { ...base, layout, layouts: [{ name: "Fixture", layout: cloneLayout(layout) }], activeLayoutIndex: 0 };
}

const paneRegistry = registry();
const detachedBridge: DesktopWindowBridge & { kind: "detached"; paneId: string } = {
  kind: "detached",
  paneId: "tabs:a",
  subscribeState: () => () => {},
  closeDetachedPane: async () => {},
};

function Ready() {
  // Two frames after the first commit: the shell has measured and laid out.
  useEffect(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => { window.__paneChrome.ready = true; }));
  }, []);
  return null;
}

window.__paneChrome = { ready: false, cell: { width: WEB_CELL_WIDTH, height: WEB_CELL_HEIGHT }, registry: paneRegistry };

const root = document.getElementById("root")!;
root.tabIndex = -1;
createRoot(root).render(
  <DomHostProviders ui={createWebUiHost(platform)} renderer={webRendererHost}>
    <AppProvider config={config()} desktopBridge={scenario === "detached" ? detachedBridge : undefined}>
      {scenario === "detached"
        ? <DetachedPaneShell pluginRegistry={paneRegistry} desktopWindowBridge={detachedBridge} />
        : <Shell pluginRegistry={paneRegistry} />}
      <Ready />
    </AppProvider>
  </DomHostProviders>,
);
