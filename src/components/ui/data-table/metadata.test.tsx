import type { ScrollBoxRenderable } from "@opentui/core";
import { describe, expect, test } from "bun:test";
import { act, useRef } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createRemoteUiRegistry, RemoteUiRegistryProvider } from "../../../remote/semantic-tree";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createDefaultConfig } from "../../../types/config";
import { DataTable } from "./index";

const tui = createOpenTuiTestHarness();

type Row = { id: string; name: string };

// More rows than the 200 the snapshot used to list, so a selection past them
// must still be published and selectable.
const rows: Row[] = Array.from({ length: 250 }, (_, index) => ({ id: `row-${index}`, name: `Row ${index}` }));

function Table({ selectedId, onSelect }: { selectedId: string | null; onSelect: (index: number) => void }) {
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
    />
  );
}

async function renderTable(selectedId: string | null) {
  const registry = createRemoteUiRegistry();
  const selected: number[] = [];
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-table-metadata"));
  await tui.render(
    <RemoteUiRegistryProvider registry={registry}>
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="table-metadata">
          <Table selectedId={selectedId} onSelect={(index) => selected.push(index)} />
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

  test("selects a row by the published selectedId", async () => {
    const { registry, node, selected } = await renderTable("row-230");
    const selectedId = node?.metadata?.selectedId;

    await registry.invoke(node!.id, "selectRow", { id: selectedId });
    await registry.invoke(node!.id, "selectRow", { key: "row-3" });

    expect(selected).toEqual([230, 3]);
  });
});
