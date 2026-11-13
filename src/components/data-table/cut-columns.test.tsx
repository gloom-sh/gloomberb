import { expect, mock, test } from "bun:test";
import { act, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { DataTableView } from "./view";

// 47 cells wide with its one-cell inset and gaps: NAME at 1-10, LAST at 12-23, CHG at 25-44. While CHG is past
// the right edge, the header ends in "more ⇧→" and the rows leave its cells blank.
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
        // Each value fills its column, so none has blank to give up and the table stays wider than the pane.
        renderCell={(row, column) => column.id === "chg"
          ? { text: row.chg.padStart(column.width), onMouseDown: () => chgPressed(row.name) }
          : { text: column.align === "right" ? row.last.padStart(column.width) : row.name.padEnd(column.width) }}
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
  // CHG is cut on the right after five cells: neither +12.40 nor its label shows a part, and the header names
  // the key that scrolls to it, Shift+Right, in the room left ("more ⇧→" where it fits).
  expect(lines()[0]).toMatch(/LAST {5}⇧→$/);
  expect(lines()[1]).toContain("1,098.53");
  expect(lines()[1]).not.toMatch(/\+1|12\.4/);

  // Fourteen cells over, LAST is cut on the left by two cells, which hold no digit. CHG's last cell is still cut.
  await scrollTo(14);
  expect(lines()[0]).toContain("LAST");
  expect(lines()[0]).not.toContain("CH");
  expect(lines()[1]).toContain("1,098.53");
  expect(lines()[2]).toContain("62.10");
  expect(lines()[1]).not.toContain("+12");

  // Seventeen over, the left edge falls inside 1,098.53 but not inside 62.10, and CHG shows whole: nothing more to say.
  await scrollTo(17);
  expect(lines()[0]).toMatch(/LAST\s+CHG/);
  expect(lines()[0]).not.toContain("more");
  expect(lines()[1]).not.toMatch(/098|,0|\b1,/);
  expect(lines()[1]).toContain("+12.40");
  expect(lines()[2]).toMatch(/62\.10\s+-0\.85/);
});

test("a press on the \"⇧→\" hint scrolls to the columns past the edge, as Shift+Right does", async () => {
  await mount();
  await act(async () => { await tui.clickFrameText("⇧→"); });
  await settle();
  const body = tui.setup().renderer.root.findDescendantById("cut-body") as ScrollBoxRenderable;
  expect(body.scrollLeft).toBe(15);
  expect(lines()[0]).toMatch(/LAST\s+CHG\s*$/);
  expect(lines()[1]).toContain("+12.40");
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

// At 52 columns FXC's Ctrl+Right stopped two cells into a column, under the frozen one: a rate too wide for the
// eight cells that showed went blank, and so did a column at the far end.
test("beside a frozen first column every sideways step and the far end start a column whole", async () => {
  const codes = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD"];
  const board = [{ id: "base", label: "", width: 5 }, ...codes.map((code) => ({ id: code, label: code, width: 10, align: "right" as const }))];
  const row = { base: "JPY", ...Object.fromEntries(codes.map((code) => [code, "0.0051574"])) } as Record<string, string>;
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-cut-columns"));
  await act(async () => {
    await tui.render(<AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="frozen-board">
        <DataTableView
          focused showHorizontalScrollbar freezeFirstColumn columns={board} items={[row]}
          selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}} getItemKey={() => "JPY"}
          renderCell={(item, column) => ({ text: item[column.id]! })}
          emptyStateTitle="No rows" headerScrollId="board-header" bodyScrollId="board-body"
        />
      </PaneInstanceProvider>
    </AppContext>, { width: 40, height: 6 });
  });
  await settle();
  const shown = () => (lines()[1]!.match(/0\.0051574/g) ?? []).length;
  const headers = () => lines()[0]!.trim().split(/\s+/);
  expect(shown()).toBe(3);
  for (let step = 0; step < 3; step++) {
    await act(async () => { await tui.emitKeypress({ name: "right", shift: true }); });
    await settle();
    // Every column in view shows its rate whole, the first beside the frozen one too.
    expect(shown(), headers().join(" ")).toBe(3);
  }
  // At the far end, the last columns, run on past by blank cells to start one whole.
  expect(headers().slice(0, 3)).toEqual(["JPY", "CHF", "CAD"]);
});

// A board set wider than its figures, as a watchlist is: at 30 cells its CHG% sat past the edge behind "⇧→".
test("a table gives up the blank past its text to show a column whole, and an empty one never says there are more", async () => {
  const board = [
    { id: "name", label: "NAME", width: 10 },
    { id: "last", label: "LAST", width: 10, align: "right" as const },
    { id: "chg", label: "CHG%", width: 10, align: "right" as const },
    { id: "note", label: "NOTE", width: 12 },
  ];
  const row = { name: "Brent", last: "62.10", chg: "-0.85%", note: "front month" } as Record<string, string>;
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-cut-columns"));
  const render = (items: Record<string, string>[]) => act(async () => {
    await tui.render(<AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="fitted-board">
        <DataTableView
          focused showHorizontalScrollbar columns={board} items={items}
          selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}} getItemKey={(item) => item.name!}
          renderCell={(item, column) => ({ text: item[column.id]! })}
          emptyStateTitle="No rows" headerScrollId="fitted-header" bodyScrollId="fitted-body"
        />
      </PaneInstanceProvider>
    </AppContext>, { width: 30, height: 8 });
  });
  await render([row]);
  await settle();
  expect(lines()[0]).toMatch(/NAME\s+LAST\s+CHG%\s+⇧→\s*$/);
  expect(lines()[1]).toContain("-0.85%");
  // NOTE starts a cell short of the edge: blank, not a stray "…".
  expect(lines()[1]).not.toContain("…");

  await render([]);
  await settle();
  expect(tui.frame()).toContain("No rows");
  expect(tui.frame()).not.toContain("⇧→");
});

test("a figure that fits itself to its column keeps the form its set width gives it, after the fit took the blank of a shorter one", async () => {
  const board = [
    { id: "name", label: "NAME", width: 8 },
    { id: "last", label: "LAST", width: 10, align: "right" as const },
    { id: "chg", label: "CHG%", width: 8, align: "right" as const },
    { id: "cap", label: "CAP", width: 8, align: "right" as const },
  ];
  // As a quote board's price does: whole while it fits its column, rounded when it does not.
  const fitted = (value: number | null, width: number) => {
    if (value == null) return "—";
    const whole = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return whole.length <= width - 1 ? whole : String(Math.round(value));
  };
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-cut-columns"));
  let load: (last: number) => void = () => {};
  function Board() {
    const [last, setLast] = useState<number | null>(null);
    load = setLast;
    return <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="self-fitting-board">
        <DataTableView
          focused showHorizontalScrollbar columns={board} items={[{ name: "BTC", last, chg: "-1.45%", cap: "1.47T" }]}
          selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}} getItemKey={(item) => item.name}
          renderCell={(item, column) => ({
            text: column.id === "last" ? fitted(item.last, column.width) : String(item[column.id as "name" | "chg" | "cap"]),
          })}
          emptyStateTitle="No rows" headerScrollId="self-fitting-header" bodyScrollId="self-fitting-body"
        />
      </PaneInstanceProvider>
    </AppContext>;
  }
  await act(async () => { await tui.render(<Board />, { width: 30, height: 6 }); });
  await settle();
  // The quote has not loaded: LAST gives up its blank so CAP shows.
  expect(lines()[0]).toMatch(/CAP/);
  // It loads: the price is drawn as its set width has it, and the table makes room for that.
  await act(async () => { load(72858.65); });
  await settle();
  expect(lines()[1]).toContain("72,858.65");
});

test("a table's columns over its rows at its width are as drawn fresh, never wider for rows or a width it had before", async () => {
  const board = [
    { id: "name", label: "NAME", width: 8, flexGrow: 1 },
    { id: "last", label: "LAST", width: 10, align: "right" as const },
    { id: "chg", label: "CHG%", width: 8, align: "right" as const },
    { id: "cap", label: "CAP", width: 8, align: "right" as const },
  ];
  type Row = { name: string; last: string; chg: string; cap: string };
  const alphabet: Row[] = [{ name: "Alphabet Inc. Class A", last: "171.20", chg: "-0.85%", cap: "2.09T" }];
  const bp: Row[] = [{ name: "BP", last: "31.08", chg: "+0.12%", cap: "84.1B" }];
  // As a name column does: whole while it fits, cut with an ellipsis when it does not.
  const clip = (text: string, width: number) => text.length <= width ? text : `${text.slice(0, width - 1)}…`;
  const state = createInitialState(createDefaultConfig("/tmp/gloom-table-cut-columns"));
  let show: (rows: Row[]) => void = () => {};
  function Board({ rows }: { rows: Row[] }) {
    const [items, setItems] = useState(rows);
    show = setItems;
    return <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="refit-board">
        <DataTableView
          focused showHorizontalScrollbar columns={board} items={items}
          selection={{ kind: "index", selectedIndex: 0, onChange: () => {} }}
          sortColumnId={null} sortDirection="asc" onHeaderClick={() => {}} getItemKey={(item) => item.name}
          renderCell={(item, column) => ({ text: column.id === "name" ? clip(item.name, column.width) : item[column.id as keyof Row] })}
          emptyStateTitle="No rows" headerScrollId="refit-header" bodyScrollId="refit-body"
        />
      </PaneInstanceProvider>
    </AppContext>;
  }
  const fresh = async (rows: Row[], width: number) => {
    await act(async () => { await tui.render(<Board rows={rows} />, { width, height: 6 }); });
    await settle();
    return tui.frame();
  };
  const bpAt30 = await fresh(bp, 30);
  const alphabetAt30 = await fresh(alphabet, 30);
  expect(bpAt30).toContain("CAP");

  // Alphabet's row replaced with BP's: its long name no longer holds the column open.
  await act(async () => { show(bp); });
  await settle();
  expect(tui.frame()).toBe(bpAt30);

  // Drawn wide, the name whole in the room the pane gives it, then narrowed again.
  await fresh(alphabet, 64);
  expect(lines()[1]).toContain("Alphabet Inc. Class A");
  await act(async () => { tui.setup().resize(30, 6); });
  await settle();
  expect(tui.frame()).toBe(alphabetAt30);
});
