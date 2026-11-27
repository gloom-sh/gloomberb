import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { getTableWidth } from "../ui/table-layout";
import type { DataTableCell } from "../ui";
import { DataTableView } from "./view";

const COLUMNS = [
  { id: "name", label: "NAME", width: 10 },
  { id: "last", label: "LAST", width: 8, align: "right" as const },
  { id: "chg", label: "CHG", width: 6, align: "right" as const },
];
type Row = { name: string; last: string; chg: string; pressable?: boolean };

const tui = createOpenTuiTestHarness();

async function frameOf(rows: Row[]): Promise<string[]> {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-spill"));
  // As wide as the columns, so the table has no room of its own to give the name.
  const width = getTableWidth(COLUMNS, 1, 1);
  await act(async () => {
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="spill-table">
          <DataTableView
            focused
            selection={{ kind: "index", selectedIndex: -1, onChange: () => {} }}
            columns={COLUMNS}
            items={rows}
            sortColumnId={null}
            sortDirection="asc"
            getItemKey={(row) => row.name + row.last}
            renderCell={(row, column): DataTableCell => column.id === "name"
              ? { text: row.name }
              : { text: column.id === "last" ? row.last : row.chg, ...row.pressable && column.id === "last" ? { onMouseDown: () => {} } : {} }}
            emptyStateTitle="No rows"
          />
        </PaneInstanceProvider>
      </AppContext>,
      { width, height: 6 },
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await tui.setup().renderOnce(); });
  return tui.frame().split("\n");
}

// A cut name beside a dash read "Definitiv…" over seven blank cells of its own row, while another row's figure
// filled the column. Each row's name now goes on into the blank its own figure leaves, keeping one before it.
test("a cut name reads on into the blank the figure after it leaves in its row, and no further", async () => {
  const lines = await frameOf([
    { name: "Definitive agreement", last: "—", chg: "+1.20%" },
    { name: "Definitive agreement signed", last: "1,098.53", chg: "+1.20%" },
    { name: "Merger vote", last: "12.5", chg: "-0.40%" },
    { name: "Tender offer extended", last: "4.10", chg: "+0.10%", pressable: true },
  ]);
  const row = (start: string) => lines.find((line) => line.trimStart().startsWith(start))!.trimEnd();
  // Up to a blank before the dash, which keeps its place.
  expect(row("Definitive agree")).toBe(" Definitive agree… — +1.20%");
  // A figure that fills its column leaves it nothing; a name that needs less takes no more.
  expect(row("Definitiv…")).toBe(" Definitiv… 1,098.53 +1.20%");
  expect(row("Merger")).toBe(" Merger vote    12.5 -0.40%");
  // A figure with a press of its own keeps its cells.
  expect(row("Tender")).toBe(" Tender of…     4.10 +0.10%");
});
