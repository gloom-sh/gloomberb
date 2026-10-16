import { expect, mock, test } from "bun:test";
import { act } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { DataTableView } from "./view";

// 47 cells wide with its one-cell inset and gaps: NAME at 1-10, LAST at 12-23, CHG at 25-44.
const COLUMNS = [
  { id: "name", label: "NAME", width: 10 },
  { id: "last", label: "LAST", width: 12, align: "right" as const },
  { id: "chg", label: "CHG", width: 20, align: "right" as const },
];
const ROWS = [
  { name: "Brent", last: "1,098.53", chg: "+12.40" },
  { name: "WTI", last: "62.10", chg: "-0.85" },
];

const tui = createOpenTuiTestHarness();
const chgPressed = mock((_symbol: string) => {});

function Harness({ frozen }: { frozen: boolean }) {
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-cut-columns"));
  return <AppContext value={createStaticAppStore(state)}>
    <PaneInstanceProvider paneId="cut-columns-table">
      <DataTableView
        focused
        showHorizontalScrollbar
        freezeFirstColumn={frozen}
        selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
        columns={COLUMNS}
        items={ROWS}
        sortColumnId={null}
        sortDirection="asc"
        onHeaderClick={() => {}}
        getItemKey={(row) => row.name}
        renderCell={(row, column) => column.id === "chg"
          ? { text: row.chg, onMouseDown: () => chgPressed(row.name) }
          : { text: row[column.id as "name" | "last"] }}
        emptyStateTitle="No rows"
        headerScrollId="cut-header"
        bodyScrollId="cut-body"
      />
    </PaneInstanceProvider>
  </AppContext>;
}

async function mount(frozen = false) {
  await act(async () => { await tui.render(<Harness frozen={frozen} />, { width: 30, height: 8 }); });
  await settle();
}
async function settle() {
  for (let i = 0; i < 4; i++) await act(async () => { await tui.setup().renderOnce(); });
}
async function scrollTo(scrollLeft: number) {
  const body = tui.setup().renderer.root.findDescendantById("cut-body") as ScrollBoxRenderable;
  await act(async () => { body.scrollLeft = scrollLeft; });
  await settle();
  return body;
}
function lines() {
  return tui.frame().split("\n");
}

function bgAt(line: number, x: number): number[] {
  let cell = 0;
  for (const span of tui.setup().captureSpans().lines[line]!.spans) {
    if (x < cell + span.width) return span.bg.toInts();
    cell += span.width;
  }
  return [];
}

test("a number cut on either side stays blank, one whose digits all show stays, and so does its label", async () => {
  await mount();
  // CHG is cut on the right after five cells: neither +12.40 nor its label shows a part.
  expect(lines()[0]).toContain("LAST");
  expect(lines()[0]).not.toContain("CH");
  expect(lines()[1]).toContain("1,098.53");
  expect(lines()[1]).not.toMatch(/\+1|12\.4/);

  // Fourteen cells over, LAST is cut on the left by two cells, which hold no digit. CHG's last cell is still cut.
  await scrollTo(14);
  expect(lines()[0]).toContain("LAST");
  expect(lines()[0]).not.toContain("CH");
  expect(lines()[1]).toContain("1,098.53");
  expect(lines()[2]).toContain("62.10");
  expect(lines()[1]).not.toContain("+12");

  // Seventeen over, the left edge falls inside 1,098.53 but not inside 62.10, and CHG shows whole.
  await scrollTo(17);
  expect(lines()[0]).toMatch(/LAST\s+CHG/);
  expect(lines()[1]).not.toMatch(/098|,0|\b1,/);
  expect(lines()[1]).toContain("+12.40");
  expect(lines()[2]).toMatch(/62\.10\s+-0\.85/);
});

test("a blanked cell keeps its row's selection and its own press", async () => {
  await mount();
  const body = await scrollTo(0);
  // The blank CHG cell of the selected row is painted as the rest of that row, not as the next one.
  expect(bgAt(1, 27)).toEqual(bgAt(1, 16));
  expect(bgAt(1, 27)).not.toEqual(bgAt(2, 27));

  chgPressed.mockClear();
  await act(async () => { await tui.setup().mockMouse.click(body.x + 27, body.y + 1); });
  await settle();
  expect(chgPressed).toHaveBeenCalledWith("WTI");
});

test("columns sliding under a frozen first column blank only what they cut", async () => {
  await mount(true);
  // Five cells over, LAST is under NAME up to its sixth cell: 1,098.53 starts in its fifth, 62.10 in its eighth.
  await scrollTo(5);
  expect(lines()[1]).toMatch(/^\s*Brent\s*$/);
  expect(lines()[2]).toMatch(/^\s*WTI\s+62\.10\s*$/);
});
