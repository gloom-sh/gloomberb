import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { emitKeypress as emitTuiKeypress, testRender, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import {
  AppContext,
  PaneInstanceProvider,
  createInitialState,
} from "../../state/app/context";
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

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (!testSetup) return;
  await act(async () => {
    testSetup!.renderer.destroy();
  });
  testSetup = undefined;
});

function Harness({ onCursor = () => {} }: { onCursor?: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [cursorIndex, setCursorIndex] = useState(1);
  const [activatedTitle, setActivatedTitle] = useState("");
  const state = createInitialState(
    createDefaultConfig("/tmp/gloomberb-data-table-view-test"),
  );
  const selectedTitle = rows[selectedIndex]?.title ?? "none";
  const cursorTitle = rows[cursorIndex]?.title ?? "none";

  return (
    <AppContext value={{ state, dispatch: () => {} }}>
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
              <Text>{`cursor=${cursorTitle} selected=${selectedTitle} activated=${activatedTitle}`}</Text>
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
    <AppContext value={{ state, dispatch: () => {} }}>
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
    <AppContext value={{ state, dispatch: () => {} }}>
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
      await testSetup!.renderOnce();
    });
  }
}

const emitKeypress = (event: TestKeyEvent) => emitTuiKeypress(testSetup!, event);

const emitKeypressBatch = (events: TestKeyEvent[]) => emitTuiKeypress(testSetup!, events);

describe("DataTableView", () => {
  test("owns row keyboard navigation and skips section headers", async () => {
    testSetup = await testRender(<Harness />, { width: 60, height: 12 });

    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("cursor=First row selected=First row");

    await emitKeypress({ name: "down", sequence: "\u001B[B" });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("cursor=Second row selected=First row");

    await emitKeypress({ name: "up", sequence: "\u001B[A", meta: true });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("cursor=Second row selected=First row");

    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("cursor=First row selected=First row");

    await emitKeypress({ name: "j", sequence: "j" });
    await emitKeypress({ name: "k", sequence: "k" });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("cursor=First row selected=First row");

    await emitKeypress({ name: "enter", sequence: "\r" });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("activated=First row");

    await emitKeypress({ name: "j", sequence: "j" });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("cursor=Second row selected=First row activated=First row");

    await emitKeypress({ name: "enter", sequence: "\r", defaultPrevented: true });
    await renderSettled();
    expect(testSetup.captureCharFrame()).toContain("cursor=Second row selected=First row activated=First row");
  });

  test("does no cursor or scroll work when navigation is already at an edge", async () => {
    let cursorChanges = 0;
    testSetup = await testRender(
      <Harness onCursor={() => { cursorChanges += 1; }} />,
      { width: 60, height: 12 },
    );

    await renderSettled();
    await emitKeypress({ name: "up", sequence: "\u001B[A" });
    await renderSettled();

    expect(cursorChanges).toBe(0);
  });

  test("keeps selection current across repeated keypresses before the next render", async () => {
    testSetup = await testRender(<Harness />, { width: 60, height: 12 });

    await renderSettled();
    await emitKeypressBatch([
      { name: "down", sequence: "\u001B[B" },
      { name: "down", sequence: "\u001B[B" },
      { name: "enter", sequence: "\r" },
    ]);
    await renderSettled();

    expect(testSetup.captureCharFrame()).toContain("selected=Third row activated=Third row");
  });

  test("keeps the immediate cursor visible while a controlled selection is deferred", async () => {
    testSetup = await testRender(
      <LargeSelectionHarness onIsSelected={() => {}} />,
      { width: 60, height: 12 },
    );

    await renderSettled();
    await emitKeypressBatch(Array.from({ length: 30 }, () => ({
      name: "down",
      sequence: "\u001B[B",
    })));
    await renderSettled();

    expect(testSetup.captureCharFrame()).toContain("Row 530");
  });

  test("renders only the visible rows and the rows changed by navigation", async () => {
    let renderedCells = 0;
    testSetup = await testRender(
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
});

test("fulfills a center request after rows are laid out and then leaves manual scrolling alone", async () => {
  const scrollSources: Array<"programmatic" | "user" | undefined> = [];
  testSetup = await testRender(
    <DeferredScrollHarness onScroll={(source) => scrollSources.push(source)} />,
    { width: 60, height: 12 },
  );
  await renderSettled();
  await act(async () => { setDeferredRows!(largeRows); });
  await renderSettled();
  const body = testSetup.renderer.root.findDescendantById("deferred-scroll-body") as ScrollBoxRenderable;
  expect(body.scrollTop).toBe(500 - Math.floor(body.viewport.height / 2));
  expect(testSetup.captureCharFrame()).toContain("Row 500");
  expect(scrollSources.at(-1)).toBe("programmatic");

  await act(async () => { body.scrollTo(50); });
  await renderSettled();
  await act(async () => { setDeferredRows!([...largeRows, { type: "row", id: "new", title: "New row" }]); });
  await renderSettled();
  expect(body.scrollTop).toBe(50);
  expect(scrollSources.at(-1)).toBe("user");
});


test("an external selection and scroll request cannot be reversed by the previous cursor", async () => {
  testSetup = await testRender(
    <DeferredScrollHarness initialRows={largeRows} initialIndex={0} controlSelection />,
    { width: 60, height: 12 },
  );
  await renderSettled();
  await act(async () => { setRequestedIndex!(500); });
  await renderSettled();
  const body = testSetup.renderer.root.findDescendantById("deferred-scroll-body") as ScrollBoxRenderable;
  expect(body.scrollTop).toBe(500 - Math.floor(body.viewport.height / 2));
  expect(testSetup.captureCharFrame()).toContain("Row 500");
});
