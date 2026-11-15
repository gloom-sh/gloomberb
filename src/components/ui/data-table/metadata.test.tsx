import type { ScrollBoxRenderable } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { DataTable } from "./index";
import { MISSING_VALUE } from "../../../utils/format";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { takeSavedTextFile } from "../../../renderers/opentui/test-utils";

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
