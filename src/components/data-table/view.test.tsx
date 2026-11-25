import { KeybindingsProvider, resolveKeybindings } from "../../app/keybindings";
import { describe, expect, jest, test } from "bun:test";
import { act, createRef, useState, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  createInitialState,
} from "../../state/app/context";
import { useShortcut } from "../../react/input";
import { PaneKeyboardScrollController } from "../../state/pane-scroll-registry";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { Box, Text } from "../../ui";
import type { DataTableCell, DataTableColumn, DataTableVisibleRange } from "../ui";
import { DataTableView } from "./view";

type Row =
  | { type: "section"; id: string; title: string }
  | { type: "row"; id: string; title: string };

type Column = DataTableColumn & { id: "title" };

const rows: Row[] = [
  { type: "section", id: "section", title: "Group" },
  { type: "row", id: "first", title: "First row" },
  { type: "row", id: "second", title: "Second row" },
  { type: "row", id: "third", title: "Third row" },
];
const largeRows: Row[] = Array.from({ length: 1_000 }, (_, index) => ({
  type: "row",
  id: `row-${index}`,
  title: `Row ${index}`,
}));

const columns: Column[] = [
  { id: "title", label: "Title", width: 20, align: "left" },
];

const tui = createOpenTuiTestHarness();

function Harness({ onCursor = () => {} }: { onCursor?: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [cursorIndex, setCursorIndex] = useState(1);
  const [activatedTitle, setActivatedTitle] = useState("");
  const [actedTitles, setActedTitles] = useState<string[]>([]);
  const state = createInitialState(
    createDefaultConfig("/tmp/gloomberb-data-table-view-test"),
  );
  const selectedTitle = rows[selectedIndex]?.title ?? "none";
  const cursorTitle = rows[cursorIndex]?.title ?? "none";
  // Action keys read the committed selection from this render, the way panes do.
  const recordAction = () => setActedTitles((titles) => [...titles, selectedTitle]);
  useShortcut((event) => {
    if (event.name === "y") recordAction();
  }, { phase: "before" });

  return (
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="data-table-view-test">
        <DataTableView<Row, Column>
          focused
          isNavigable={(row) => row.type === "row"}
          selection={{
            kind: "index",
            selectedIndex,
            onChange: (index) => setSelectedIndex(index),
          }}
          onCursorChange={(_row, index) => {
            onCursor();
            setCursorIndex(index);
          }}
          onActivate={(row) => {
            if (row.type === "row") setActivatedTitle(row.title);
          }}
          onRootKeyDown={(event) => {
            if (event.name !== "x") return;
            recordAction();
            return true;
          }}
          columns={columns}
          items={rows}
          sortColumnId={null}
          sortDirection="asc"
          onHeaderClick={() => {}}
          getItemKey={(row) => row.id}
          renderSectionHeader={(row) => row.type === "section"
            ? { text: row.title }
            : null}
          renderCell={(row): DataTableCell => ({
            text: row.type === "row" ? row.title : "",
          })}
          emptyStateTitle="No rows"
          rootAfter={
            <Box height={1}>
              <Text>{`cursor=${cursorTitle} selected=${selectedTitle} activated=${activatedTitle} acted=${actedTitles.join(",")}`}</Text>
            </Box>
          }
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

function LargeSelectionHarness({
  onIsSelected,
}: {
  onIsSelected: () => void;
}) {
  const state = createInitialState(
    createDefaultConfig("/tmp/gloomberb-data-table-view-large-test"),
  );

  return (
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="data-table-view-large-test">
        <DataTableView<Row, Column>
          focused
          selection={{
            kind: "index",
            selectedIndex: 500,
            onChange: () => {},
          }}
          columns={columns}
          items={largeRows}
          sortColumnId={null}
          sortDirection="asc"
          onHeaderClick={() => {}}
          getItemKey={(row) => row.id}
          renderCell={(row, _column, index): DataTableCell => {
            onIsSelected();
            return { text: row.title + (index === 500 ? "" : "") };
          }}
          emptyStateTitle="No rows"
          scrollToIndex={500}
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

/** A read-only table: no cursor, so the pane scroll keys are what move it. */
function NoCursorHarness() {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-data-table-view-no-cursor-test"));
  return (
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="data-table-view-no-cursor-test">
        <PaneKeyboardScrollController paneId="data-table-view-no-cursor-test" focused />
        <DataTableView<Row, Column>
          focused
          selection={{ kind: "none" }}
          columns={columns}
          items={largeRows}
          sortColumnId={null}
          sortDirection="asc"
          getItemKey={(row) => row.id}
          renderCell={(row): DataTableCell => ({ text: row.title })}
          emptyStateTitle="No rows"
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

let rerenderParent: (() => void) | undefined;
let parentRenderedCells = 0;
const renderCountedCell = (row: Row): DataTableCell => {
  parentRenderedCells += 1;
  return { text: row.title };
};

/** Builds `selection` inline, as most panes do, with a stable `renderCell`. */
function InlineSelectionHarness() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [, setRenderCount] = useState(0);
  rerenderParent = () => setRenderCount((count) => count + 1);
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-data-table-view-inline-test"));
  return (
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="data-table-view-inline-test">
        <DataTableView<Row, Column>
          focused
          selection={{ kind: "index", selectedIndex, onChange: (index) => setSelectedIndex(index) }}
          columns={columns}
          items={largeRows}
          sortColumnId={null}
          sortDirection="asc"
          getItemKey={(row) => row.id}
          renderCell={renderCountedCell}
          emptyStateTitle="No rows"
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

let setDeferredRows: ((rows: Row[]) => void) | undefined;
let setRequestedIndex: ((index: number) => void) | undefined;

function DeferredScrollHarness({ onScroll, initialRows = [], initialIndex = 500, controlSelection = false }: {
  onScroll?: (source?: "programmatic" | "user") => void;
  initialRows?: Row[];
  initialIndex?: number;
  controlSelection?: boolean;
}) {
  const [items, setItems] = useState<Row[]>(initialRows);
  const [requestedIndex, requestIndex] = useState(initialIndex);
  setDeferredRows = setItems;
  setRequestedIndex = requestIndex;
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-table-deferred-scroll"));
  return (
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="deferred-scroll-test">
        <DataTableView<Row, Column>
          focused
          selection={controlSelection
            ? { kind: "index", selectedIndex: requestedIndex, onChange: requestIndex }
            : { kind: "none" }}
          columns={columns}
          items={items}
          sortColumnId={null}
          sortDirection="asc"
          onHeaderClick={() => {}}
          getItemKey={(row) => row.id}
          renderCell={(row) => ({ text: row.title })}
          emptyStateTitle="Loading rows"
          bodyScrollId="deferred-scroll-body"
          scrollToIndex={requestedIndex}
          scrollToIndexAlign="center"
          resetScrollKey="contract-chain"
          onBodyScrollActivity={onScroll}
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function renderSettled() {
  // Commit React's measurement/scroll effects between native frames, then
  // paint the resulting viewport. One act around every frame can leave the
  // numeric scroll offset updated while the captured frame is still old.
  for (let phase = 0; phase < 3; phase += 1) {
    await act(async () => {
      await tui.setup().renderOnce();
    });
  }
}

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event);

const emitKeypressBatch = (events: TestKeyEvent[]) => tui.emitKeypress(events);

describe("DataTableView", () => {
  test("configured row keys move the cursor and commit it before a row action", async () => {
    const navigation = resolveKeybindings({ actions: { "navigate-down": "è", "navigate-up": "é" } });
    await tui.render(<KeybindingsProvider value={navigation}><Harness /></KeybindingsProvider>, { width: 100, height: 12 });
    await renderSettled();
    await emitKeypress({ name: "j", sequence: "j" });
    await renderSettled();
    expect(tui.frame()).toContain("cursor=First row selected=First row");
    await emitKeypressBatch([{ name: "è", sequence: "è" }, { name: "è", sequence: "è" }, { name: "x", sequence: "x" }]);
    await renderSettled();
    expect(tui.frame()).toContain("cursor=Third row selected=Third row");
    expect(tui.frame()).toContain("acted=Third row");
  });

  test("owns row keyboard navigation and skips section headers", async () => {
    await tui.render(<Harness />, { width: 60, height: 12 });

    await renderSettled();
    expect(tui.frame()).toContain("cursor=First row selected=First row");

    // The first step after a pause commits at once; the steps that follow
    // inside the commit window only move the cursor.
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderSettled();
    expect(tui.frame()).toContain("cursor=Second row selected=Second row");

    await emitKeypress({ name: "up", sequence: "\u001B[A", meta: true });
    await renderSettled();
    expect(tui.frame()).toContain("cursor=Second row selected=Second row");

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await renderSettled();
    expect(tui.frame()).toContain("cursor=First row selected=Second row");

    await emitKeypress({ name: "j", sequence: "j" });
    await emitKeypress({ name: "k", sequence: "k" });
    await renderSettled();
    expect(tui.frame()).toContain("cursor=First row selected=Second row");

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    expect(tui.frame()).toContain("activated=First row");

    await emitKeypress({ name: "j", sequence: "j" });
    await renderSettled();
    expect(tui.frame()).toContain("cursor=Second row selected=First row activated=First row");

    await emitKeypress({ name: "enter", sequence: "\r", defaultPrevented: true });
    await renderSettled();
    expect(tui.frame()).toContain("cursor=Second row selected=First row activated=First row");
  });

  test("an action key pressed while a cursor step is pending acts on the cursor row", async () => {
    await tui.render(<Harness />, { width: 100, height: 12 });
    await renderSettled();

    jest.useFakeTimers();
    try {
      // The first step commits at once; the step back sits in the commit window.
      await emitKeypress({ name: "down", sequence: "\u001B[B" });
      await emitKeypress({ name: "up", sequence: "\u001B[A" });
      await renderSettled();
      expect(tui.frame()).toContain("cursor=First row selected=Second row");

      // One handler runs before the table's own and one is the table's.
      await emitKeypress({ name: "y", sequence: "y" });
      await emitKeypress({ name: "x", sequence: "x" });
      await renderSettled();
      expect(tui.frame()).toContain("selected=First row activated= acted=First row,First row");
    } finally {
      jest.useRealTimers();
    }
  });

  test("does no cursor or scroll work when navigation is already at an edge", async () => {
    let cursorChanges = 0;
    await tui.render(
      <Harness onCursor={() => { cursorChanges += 1; }} />,
      { width: 60, height: 12 },
    );

    await renderSettled();
    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await renderSettled();

    expect(cursorChanges).toBe(0);
  });

  test("leaves the scroll keys to the pane when the table has no cursor", async () => {
    // A key the table claims is stopped, as in the app, so the pane scroll keys skip it.
    const pressTracked = (event: TestKeyEvent) => tui.emitKeypress(event, { trackPropagation: true });
    await tui.render(<NoCursorHarness />, { width: 60, height: 12 });
    await renderSettled();
    expect(tui.frame()).toContain("Row 0");

    await pressTracked({ name: "pagedown", sequence: "\u001B[6~" });
    await renderSettled();
    expect(tui.frame()).not.toContain("Row 0\n");
    expect(tui.frame()).toContain("Row 10");

    await pressTracked({ name: "end", sequence: "\u001B[F" });
    await renderSettled();
    expect(tui.frame()).toContain("Row 999");

    await pressTracked({ name: "home", sequence: "\u001B[H" });
    await renderSettled();
    expect(tui.frame()).toContain("Row 0");
  });

  test("keeps selection current across repeated keypresses before the next render", async () => {
    await tui.render(<Harness />, { width: 60, height: 12 });

    await renderSettled();
    await emitKeypressBatch([
      { name: "down", sequence: "\u001B[B" },
      { name: "down", sequence: "\u001B[B" },
      { name: "enter", sequence: "\r" },
    ]);
    await renderSettled();

    expect(tui.frame()).toContain("selected=Third row activated=Third row");
  });

  test("keeps the immediate cursor visible while a controlled selection is deferred", async () => {
    await tui.render(
      <LargeSelectionHarness onIsSelected={() => {}} />,
      { width: 60, height: 12 },
    );

    await renderSettled();
    await emitKeypressBatch(Array.from({ length: 30 }, () => ({
      name: "down",
      sequence: "\u001B[B",
    })));
    await renderSettled();

    expect(tui.frame()).toContain("Row 530");
  });

  test("renders only the visible rows and the rows changed by navigation", async () => {
    let renderedCells = 0;
    await tui.render(
      <LargeSelectionHarness
        onIsSelected={() => {
          renderedCells += 1;
        }}
      />,
      { width: 60, height: 12 },
    );

    await renderSettled();
    expect(renderedCells).toBeLessThan(150);

    const beforeNavigation = renderedCells;
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderSettled();

    expect(renderedCells - beforeNavigation).toBeLessThanOrEqual(4);
  });

  test("keeps unchanged rows memoized when the parent re-renders with an inline selection", async () => {
    await tui.render(<InlineSelectionHarness />, { width: 60, height: 12 });
    await renderSettled();

    parentRenderedCells = 0;
    await act(async () => { rerenderParent?.(); });
    await renderSettled();
    expect(parentRenderedCells).toBe(0);

    // A keypress commits the selection, which re-renders the parent with a new
    // selection object; only the two rows whose selected state flipped repaint.
    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderSettled();
    expect(parentRenderedCells).toBeLessThanOrEqual(4);
  });
});

test("an external row update redraws only that row", async () => {
  const data: Row[] = [
    { type: "row", id: "btc", title: "BTC 10" },
    { type: "row", id: "eth", title: "ETH 20" },
  ];
  const values = new Map(data.map((row) => [row.id, row]));
  const versions = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const source = {
    subscribe(row: Row, listener: () => void) {
      const set = listeners.get(row.id) ?? new Set();
      set.add(listener); listeners.set(row.id, set);
      return () => { set.delete(listener); };
    },
    version: (row: Row) => versions.get(row.id) ?? 0,
    read: (row: Row) => values.get(row.id) ?? row,
  };
  const renders = new Map<string, number>();
  const renderCell = (row: Row): DataTableCell => {
    renders.set(row.id, (renders.get(row.id) ?? 0) + 1);
    return { text: row.title };
  };
  const state = createInitialState(createDefaultConfig(":memory:"));
  let boardRenders = 0;
  function Board() {
    boardRenders++;
    return <DataTableView<Row, Column> focused selection={{ kind: "none" }} columns={columns} items={data}
      sortColumnId={null} sortDirection="asc" getItemKey={(row) => row.id} rowSource={source}
      renderCell={renderCell} emptyStateTitle="No rows" />;
  }
  await tui.render(<AppContext value={createStaticAppStore(state)}><PaneInstanceProvider paneId="observed-table">
    <Board />
  </PaneInstanceProvider></AppContext>, { width: 60, height: 12 });
  await renderSettled();
  const boardRendersBefore = boardRenders;
  renders.clear();
  await act(async () => {
    values.set("btc", { type: "row", id: "btc", title: "BTC 11" });
    versions.set("btc", 1);
    for (const listener of listeners.get("btc") ?? []) listener();
  });
  await renderSettled();
  expect(tui.frame()).toContain("BTC 11");
  expect(renders.get("btc") ?? 0).toBeGreaterThan(0);
  expect(renders.get("eth") ?? 0).toBe(0);
  expect(boardRenders).toBe(boardRendersBefore);
  await tui.destroy();
  expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test("fulfills a center request after rows are laid out and then leaves manual scrolling alone", async () => {
  const scrollSources: Array<"programmatic" | "user" | undefined> = [];
  await tui.render(
    <DeferredScrollHarness onScroll={(source) => scrollSources.push(source)} />,
    { width: 60, height: 12 },
  );
  await renderSettled();
  await act(async () => { setDeferredRows!(largeRows); });
  await renderSettled();
  const body = tui.setup().renderer.root.findDescendantById("deferred-scroll-body") as ScrollBoxRenderable;
  expect(body.scrollTop).toBe(500 - Math.floor(body.viewport.height / 2));
  expect(tui.frame()).toContain("Row 500");
  expect(scrollSources.at(-1)).toBe("programmatic");

  await act(async () => { body.scrollTo(50); });
  await renderSettled();
  await act(async () => { setDeferredRows!([...largeRows, { type: "row", id: "new", title: "New row" }]); });
  await renderSettled();
  expect(body.scrollTop).toBe(50);
  expect(scrollSources.at(-1)).toBe("user");

  await act(async () => { setDeferredRows!([]); });
  await renderSettled();
  expect(body.scrollTop).toBe(0);
  expect(scrollSources.at(-1)).toBe("programmatic");
  expect(tui.frame()).toContain("Loading rows");
  await act(async () => { setDeferredRows!(largeRows); });
  await renderSettled();
  expect(body.scrollTop).toBe(500 - Math.floor(body.viewport.height / 2));
  await act(async () => { body.scrollTo(50); });
  await renderSettled();
  expect(scrollSources.at(-1)).toBe("user");
});


test("an external selection and scroll request cannot be reversed by the previous cursor", async () => {
  await tui.render(
    <DeferredScrollHarness initialRows={largeRows} initialIndex={0} controlSelection />,
    { width: 60, height: 12 },
  );
  await renderSettled();
  await act(async () => { setRequestedIndex!(500); });
  await renderSettled();
  const body = tui.setup().renderer.root.findDescendantById("deferred-scroll-body") as ScrollBoxRenderable;
  expect(body.scrollTop).toBe(500 - Math.floor(body.viewport.height / 2));
  expect(tui.frame()).toContain("Row 500");
});

type StatementLine = { id: string; kind: "period-end" | "heading" | "line"; title: string };
/** A statement: a Period end row and a heading the cursor passes over, around lines it stops on. */
const statementLines: StatementLine[] = [
  { id: "period-end", kind: "period-end", title: "Period end" },
  ...Array.from({ length: 30 }, (_, index) => ({ id: `income-${index}`, kind: "line" as const, title: `Income ${index}` })),
  { id: "balance", kind: "heading", title: "Balance sheet" },
  ...Array.from({ length: 30 }, (_, index) => ({ id: `balance-${index}`, kind: "line" as const, title: `Balance ${index}` })),
];
const BALANCE_HEADING = 31;

function ScrollHarness({ items, navigable, scrollRef, ranges }: {
  items: StatementLine[];
  navigable: boolean;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  ranges: DataTableVisibleRange[];
}) {
  const [selectedIndex, setSelectedIndex] = useState(navigable ? 1 : 0);
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-data-table-view-scroll-test"));
  return (
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="data-table-view-scroll-test">
        <DataTableView<StatementLine, Column>
          focused
          isNavigable={navigable ? (line) => line.kind === "line" : undefined}
          selection={{ kind: "index", selectedIndex, onChange: (index) => setSelectedIndex(index) }}
          scrollRef={scrollRef}
          onVisibleRangeChange={(range) => ranges.push(range)}
          columns={columns}
          items={items}
          sortColumnId={null}
          sortDirection="asc"
          getItemKey={(line) => line.id}
          renderSectionHeader={(line) => line.kind === "heading" ? { text: line.title } : null}
          renderCell={(line): DataTableCell => ({ text: line.kind === "heading" ? "" : line.title })}
          emptyStateTitle="No rows"
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

const DOWN: TestKeyEvent = { name: "down", sequence: "\u001B[B" };
const UP: TestKeyEvent = { name: "up", sequence: "\u001B[A" };

async function pressKeys(event: TestKeyEvent, count = 1) {
  await emitKeypressBatch(Array.from({ length: count }, () => event));
  await renderSettled();
}

// FA's Period end row: back up a statement by key, the cursor stopped on the first figure and Period end stayed hidden above it.
test("the rows the cursor passes over above its first row come back into view as it returns there", async () => {
  const scrollRef = createRef<ScrollBoxRenderable>();
  const ranges: DataTableVisibleRange[] = [];
  await tui.render(<ScrollHarness items={statementLines} navigable scrollRef={scrollRef} ranges={ranges} />, { width: 60, height: 12 });
  await renderSettled();
  expect(tui.frame()).toContain("Period end");

  const returns: Array<[string, TestKeyEvent, number]> = [
    ["up", UP, 40],
    ["home", { name: "home", sequence: "\u001B[H" }, 1],
    ["page up", { name: "pageup", sequence: "\u001B[5~" }, 10],
  ];
  for (const [label, key, count] of returns) {
    await pressKeys(DOWN, 40);
    expect(scrollRef.current!.scrollTop, label).toBeGreaterThan(0);
    expect(tui.frame(), label).not.toContain("Period end");
    await pressKeys(key, count);
    expect(tui.frame(), label).toContain("Period end");
    expect(scrollRef.current!.scrollTop, label).toBe(0);
    expect(ranges.at(-1)?.start, label).toBe(0);
  }

  // A section's first line brings its heading along, which then heads the view.
  await pressKeys({ name: "end", sequence: "\u001B[F" });
  await pressKeys(UP, 29);
  expect(scrollRef.current!.scrollTop).toBe(BALANCE_HEADING);
  expect(tui.frame()).toContain("Balance sheet");

  // A press scrolls nothing: the row under the pointer stays put for a second click.
  await act(async () => { scrollRef.current!.scrollTo(1); });
  await renderSettled();
  await tui.clickFrameText("Income 0");
  await renderSettled();
  expect(scrollRef.current!.scrollTop).toBe(1);
});

test("a table the cursor stops on every row of scrolls one row at a time, as it always has", async () => {
  const scrollRef = createRef<ScrollBoxRenderable>();
  const ranges: DataTableVisibleRange[] = [];
  const items = statementLines.filter((line) => line.kind === "line");
  await tui.render(<ScrollHarness items={items} navigable={false} scrollRef={scrollRef} ranges={ranges} />, { width: 60, height: 12 });
  await renderSettled();
  const height = scrollRef.current!.viewport.height;

  await pressKeys(DOWN, 40);
  expect(scrollRef.current!.scrollTop).toBe(40 - height + 1);
  // Up to the top row on screen moves no rows; the step past it moves one.
  await pressKeys(UP, height - 1);
  expect(scrollRef.current!.scrollTop).toBe(40 - height + 1);
  await pressKeys(UP);
  expect(scrollRef.current!.scrollTop).toBe(40 - height);
  await pressKeys({ name: "home", sequence: "\u001B[H" });
  expect(scrollRef.current!.scrollTop).toBe(0);
  expect(ranges.at(-1)?.start).toBe(0);
});

// Help's wrapped rows: pressing a row's second line did nothing, since that line is not a row the cursor stops on.
test("pressing a line that goes on from the row above selects that row", async () => {
  type Line = { id: string; owner: string; text: string; continued: boolean };
  const lines: Line[] = [
    { id: "a", owner: "Alpha", text: "Alpha says", continued: false },
    { id: "a~1", owner: "Alpha", text: "more of alpha", continued: true },
    { id: "b", owner: "Beta", text: "Beta says", continued: false },
    { id: "b~1", owner: "Beta", text: "more of beta", continued: true },
  ];
  function WrappedHarness() {
    const [selected, setSelected] = useState("a");
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-data-table-view-wrapped-test"));
    return (
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="data-table-view-wrapped-test">
          <DataTableView<Line, Column>
            focused
            isNavigable={(line) => !line.continued}
            continuesRowAbove={(line) => line.continued}
            selection={{ kind: "id", selectedId: selected, getId: (line) => line.id, onChange: (id) => setSelected(String(id)) }}
            columns={columns}
            items={lines}
            sortColumnId={null}
            sortDirection="asc"
            getItemKey={(line) => line.id}
            renderCell={(line): DataTableCell => ({ text: line.text })}
            emptyStateTitle="No rows"
            rootAfter={<Box height={1}><Text>{`selected=${selected}`}</Text></Box>}
          />
        </PaneInstanceProvider>
      </AppContext>
    );
  }
  await act(async () => {
    await tui.render(<WrappedHarness />, { width: 40, height: 10 });
  });
  await renderSettled();
  expect(tui.frame()).toContain("selected=a");
  await tui.clickFrameText("more of beta");
  await renderSettled();
  expect(tui.frame()).toContain("selected=b");
  expect(tui.frame()).not.toContain("selected=b~1");
});

// CSP, EXPO and RV put a note about one row in the pane's footer, where it reads as the pane's.
test("a row's note is said under the table while that row is selected, and follows the selection", async () => {
  const notes: Record<string, string> = { second: "Second: no current price for the underlying." };
  function NotedHarness() {
    const [selected, setSelected] = useState("first");
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-data-table-view-row-note-test"));
    return (
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="data-table-view-row-note-test">
          <DataTableView<Row, Column>
            focused
            isNavigable={(row) => row.type === "row"}
            selection={{ kind: "id", selectedId: selected, getId: (row) => row.id, onChange: (id) => setSelected(String(id)) }}
            columns={columns}
            items={rows}
            sortColumnId={null}
            sortDirection="asc"
            getItemKey={(row) => row.id}
            renderCell={(row): DataTableCell => ({ text: row.title })}
            rowNote={(row) => notes[row.id] ?? null}
            emptyStateTitle="No rows"
          />
        </PaneInstanceProvider>
      </AppContext>
    );
  }
  await act(async () => {
    await tui.render(<NotedHarness />, { width: 60, height: 10 });
  });
  await renderSettled();
  expect(tui.frame()).not.toContain("no current price");
  await tui.clickFrameText("Second row");
  await renderSettled();
  expect(tui.frame()).toContain("Second: no current price for the underlying.");
  await tui.clickFrameText("Third row");
  await renderSettled();
  expect(tui.frame()).not.toContain("no current price");
});
