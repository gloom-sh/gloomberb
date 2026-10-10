import { describe, expect, jest, test } from "bun:test";
import { act, useState } from "react";
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
import type { DataTableCell, DataTableColumn } from "../ui";
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
