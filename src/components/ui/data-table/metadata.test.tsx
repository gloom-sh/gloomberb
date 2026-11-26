import type { ScrollBoxRenderable } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import { act, useEffect, useRef } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { DataTable } from "./index";
import { MISSING_VALUE } from "../../../utils/format";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { takeSavedTextFile } from "../../../renderers/opentui/test-utils";
import { UiHostProvider, useRendererHost, useUiHost } from "../../../ui/host";
import type { DataTableProps } from "./types";
import { getLanguage, setLanguage } from "../../../i18n";
import { registerTranslations, tPlugin, useAppLanguage } from "../../../public/i18n";
import { Text } from "../../../ui";

const tui = createOpenTuiTestHarness();

type Row = { id: string; name: string };

// More rows than the 200 the snapshot used to list, so a selection past them
// must still be published and selectable.
const rows: Row[] = Array.from({ length: 250 }, (_, index) => ({ id: `row-${index}`, name: `Row ${index}` }));

function Table({ selectedId, onSelect, reportEveryRow }: { selectedId: string | null; onSelect: (index: number) => void; reportEveryRow?: boolean }) {
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  return (
    <DataTable
      columns={[{ id: "name", label: "Name", width: 12, align: "left" }]}
      items={rows}
      sortColumnId="name"
      sortDirection="desc"
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      syncHeaderScroll={() => {}}
      onBodyScrollActivity={() => {}}
      getItemKey={(row) => row.id}
      isSelected={(row) => row.id === selectedId}
      onSelect={(_row, index) => onSelect(index)}
      renderCell={(row) => ({ text: row.name })}
      emptyStateTitle="No rows."
      reportEveryRow={reportEveryRow}
    />
  );
}

async function renderTable(selectedId: string | null, reportEveryRow?: boolean) {
  const registry = createRemoteUiRegistry();
  const selected: number[] = [];
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-table-metadata"));
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="table-metadata">
          <Table selectedId={selectedId} onSelect={(index) => selected.push(index)} reportEveryRow={reportEveryRow} />
        </PaneInstanceProvider>
      </AppContext>
    </RemoteUiRegistryProvider>,
    { width: 32, height: 6 },
  );
  await act(async () => {
    await tui.setup().renderOnce();
  });
  const node = registry.snapshot().find((entry) => entry.role === "table");
  return { registry, node, selected };
}

describe("DataTable remote metadata", () => {
  test("refreshes opted-in headers and plugin UI without translating other tables, CSV or automation", async () => {
    const previousLanguage = getLanguage();
    const registry = createRemoteUiRegistry();
    const state = createInitialState(createDefaultConfig(":memory:"));
    const items = [{ id: "one", name: "One" }];
    function Status() {
      const language = useAppLanguage();
      return <Text>{language}: {tPlugin("market-tool", "status", "Ready")}</Text>;
    }
    function PriceTable({ translated }: { translated?: boolean }) {
      const scrollRef = useRef<ScrollBoxRenderable>(null);
      return <DataTable columns={[{ id: "open", label: "Open", width: 18, align: "left",
        ...(translated ? { labelTranslation: { pluginId: "market-tool", key: "opening-price" } } : {}) }]}
        items={items} sortColumnId={null} sortDirection="asc" scrollRef={scrollRef} headerScrollRef={scrollRef}
        syncHeaderScroll={() => {}} onBodyScrollActivity={() => {}} getItemKey={(row) => row.id}
        isSelected={() => false} onSelect={() => {}} renderCell={(row) => ({ text: row.name })}
        emptyStateTitle="No rows" reportEveryRow />;
    }
    let removeEs: (() => void) | undefined;
    const removeJa = registerTranslations("market-tool", "ja", { "opening-price": "始値", status: "準備完了" });
    try {
      setLanguage("es");
      await tui.render(<RemoteUiRegistryProvider registry={registry}><AppContext value={createStaticAppStore(state)}>
        <Status />
        <PaneInstanceProvider paneId="translated-header"><PriceTable translated /></PaneInstanceProvider>
        <PaneInstanceProvider paneId="unrelated-header"><PriceTable /></PaneInstanceProvider>
      </AppContext></RemoteUiRegistryProvider>, { width: 50, height: 16 });
      expect(await tui.waitForFrameToContain("es: Ready")).not.toContain("APERTURA LOCAL");
      await act(async () => {
        removeEs = registerTranslations("market-tool", "es", { "opening-price": "apertura local", status: "Listo" });
      });
      const translated = await tui.waitForFrameToContain("APERTURA LOCAL");
      expect(translated).toContain("es: Listo");
      expect(translated.match(/\bOPEN\b/g)).toHaveLength(1);
      const table = registry.snapshot().find((entry) => entry.metadata?.paneInstanceId === "translated-header" && entry.role === "table");
      expect(table?.metadata?.columns).toEqual([{ id: "open", label: "Open" }]);
      await exportPaneTable("translated-header", "translated.csv");
      expect(takeSavedTextFile()?.text).toBe("\uFEFFOpen\nOne");

      await act(async () => { setLanguage("ja"); });
      const japanese = await tui.waitForFrameToContain("始値");
      expect(japanese).toContain("ja: 準備完了");
      expect(japanese.match(/\bOPEN\b/g)).toHaveLength(1);

      await act(async () => { removeJa(); });
      const disposed = await tui.waitForFrameToContain("ja: Ready");
      expect(disposed).not.toContain("始値");
      expect(disposed.match(/\bOPEN\b/g)).toHaveLength(2);
    } finally {
      await tui.destroy();
      removeJa();
      removeEs?.();
      setLanguage(previousLanguage);
    }
  });

  test("reports and exports the latest externally updated row without rerendering the table", async () => {
    const original = { id: "one", name: "Before" };
    let current = original;
    let version = 0;
    const listeners = new Set<() => void>();
    const source = {
      subscribe(_row: typeof original, listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      version: () => version,
      read: () => current,
    };
    function TableWithLiveRow() {
      const scrollRef = useRef<ScrollBoxRenderable>(null);
      return <DataTable columns={[{ id: "name", label: "Name", width: 12, align: "left" }]}
        items={[original]} sortColumnId={null} sortDirection="asc" scrollRef={scrollRef} headerScrollRef={scrollRef}
        syncHeaderScroll={() => {}} onBodyScrollActivity={() => {}} getItemKey={(row) => row.id}
        isSelected={() => false} onSelect={() => {}} rowSource={source} renderCell={(row) => ({ text: row.name })}
        exportIdentity={{ headers: ["Identity"], cells: (row) => [row.name] }}
        emptyStateTitle="No rows" reportEveryRow />;
    }
    const registry = createRemoteUiRegistry();
    const state = createInitialState(createDefaultConfig(":memory:"));
    await tui.render(<RemoteUiRegistryProvider registry={registry}><AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="live-export"><TableWithLiveRow /></PaneInstanceProvider>
    </AppContext></RemoteUiRegistryProvider>, { width: 40, height: 6 });
    expect(JSON.stringify(registry.snapshot())).toContain("Before");
    await act(async () => { current = { ...original, name: "After" }; version++; for (const listener of listeners) listener(); });
    expect(JSON.stringify(registry.snapshot())).toContain("After");
    await exportPaneTable("live-export", "live.csv");
    expect(takeSavedTextFile()?.text).toContain("Name,Identity\nAfter,After");
  });
  test("an omitted column stays report-only in JSON and present in the registered CSV export", async () => {
    function OptionalTable() {
      const scrollRef = useRef<ScrollBoxRenderable>(null);
      return <DataTable columns={[
        { id: "name", label: "Name", width: 12, align: "left" },
        { id: "missing", label: "Missing", width: 10, align: "right", omitWhenEmpty: true },
      ]} items={[{ id: "one", name: "One" }]} sortColumnId={null} sortDirection="asc"
        scrollRef={scrollRef} headerScrollRef={scrollRef} syncHeaderScroll={() => {}} onBodyScrollActivity={() => {}}
        getItemKey={(row) => row.id} isSelected={() => false} onSelect={() => {}}
        renderCell={(row, column) => column.id === "name" ? { text: row.name } : { text: MISSING_VALUE, value: null }}
        emptyStateTitle="No rows." reportEveryRow />;
    }
    const registry = createRemoteUiRegistry();
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-optional-column"));
    await act(async () => {
      await tui.render(<RemoteUiRegistryProvider registry={registry}>
        <AppContext value={createStaticAppStore(state)}>
          <PaneInstanceProvider paneId="optional-column"><OptionalTable /></PaneInstanceProvider>
        </AppContext>
      </RemoteUiRegistryProvider>, { width: 40, height: 6 });
    });
    const node = registry.snapshot().find((entry) => entry.role === "table");
    expect(tui.frame()).not.toContain("MISSING");
    expect(node?.metadata?.columns).toEqual([{ id: "name", label: "Name" }]);
    expect(node?.metadata?.rows).toEqual([{ key: "one", selected: false, cells: [
      { columnId: "name", columnLabel: "Name", text: "One" },
      { columnId: "missing", columnLabel: "Missing", text: MISSING_VALUE, reportOnly: true },
    ] }]);
    await exportPaneTable("optional-column", "optional.csv");
    expect(takeSavedTextFile()?.text).toContain("Name,Missing\nOne,");
  });

  test("a range with no rows in it, from a viewport not laid out yet, never hides an in-view column", async () => {
    // The host table reports before its viewport has a size, then the rows it shows.
    const drawn: string[][] = [];
    function HostTable(props: DataTableProps<Row>) {
      drawn.push(props.columns.map((column) => column.id));
      useEffect(() => {
        props.onVisibleRangeChange?.({ start: 0, end: 0 });
        const measured = setTimeout(() => props.onVisibleRangeChange?.({ start: 0, end: 1 }), 0);
        return () => clearTimeout(measured);
      }, []);
      return null;
    }
    function Host() {
      const scrollRef = useRef<ScrollBoxRenderable>(null);
      return <UiHostProvider ui={{ ...useUiHost(), DataTable: HostTable }} renderer={useRendererHost()}>
        <DataTable columns={[{ id: "name", label: "Name", width: 12, align: "left" }, { id: "value", label: "Value", width: 8, align: "right", omitWhenEmpty: "visible" }]}
          items={[{ id: "one", name: "One" }]} sortColumnId={null} sortDirection="asc" scrollRef={scrollRef} headerScrollRef={scrollRef}
          syncHeaderScroll={() => {}} onBodyScrollActivity={() => {}} getItemKey={(row) => row.id} isSelected={() => false} onSelect={() => {}}
          renderCell={(row, column) => ({ text: column.id === "name" ? row.name : "12.5" })} emptyStateTitle="No rows." />
      </UiHostProvider>;
    }
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-unmeasured-range"));
    await act(async () => {
      await tui.render(<AppContext value={createStaticAppStore(state)}><Host /></AppContext>, { width: 40, height: 6 });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.every((columns) => columns.includes("value"))).toBe(true);
  });

  test("publishes the row count and a selected key past the first 200 rows, without row objects", async () => {
    const { node } = await renderTable("row-230");

    expect(node?.metadata).toEqual({
      paneInstanceId: "table-metadata",
      sortColumnId: "name",
      sortDirection: "desc",
      columns: [{ id: "name", label: "Name" }],
      rowCount: 250,
      selectedId: "row-230",
    });
  });

  test("a table that reports every row publishes each one as its cells read, past the viewport", async () => {
    const { node } = await renderTable("row-230", true);
    const reported = node?.metadata?.rows as Array<{ key: string; selected: boolean; cells: Array<{ columnId: string; text: string }> }>;

    expect(reported).toHaveLength(250);
    expect(reported[249]).toEqual({ key: "row-249", selected: false, cells: [{ columnId: "name", columnLabel: "Name", text: "Row 249" }] });
    expect(reported[230]!.selected).toBe(true);
  });

  test("selects a row by the published selectedId", async () => {
    const { registry, node, selected } = await renderTable("row-230");
    const selectedId = node?.metadata?.selectedId;

    await registry.invoke(node!.id, "selectRow", { id: selectedId });
    await registry.invoke(node!.id, "selectRow", { key: "row-3" });

    expect(selected).toEqual([230, 3]);
  });
});
