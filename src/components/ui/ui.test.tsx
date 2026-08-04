import { afterEach, describe, expect, test } from "bun:test";
import { act, createRef, useEffect, useRef, useState } from "react";
import { TestDialogProvider, testRender } from "../../renderers/opentui/test-utils";
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { ChoiceDialog } from "./choice-dialog";
import { DataTable, type DataTableColumn, type DataTableVisibleRange } from "./data-table";
import { TextField } from "./fields";
import { ListView } from "./list-view";
import { MultiSelectDialogButton, type MultiSelectDialogButtonHandle } from "./multi-select/dialog";
import {
  getMultiSelectDisplayValues,
  moveMultiSelectDisplayValue,
  normalizeOrderedMultiSelectValues,
  orderMultiSelectOptionsForDisplay,
  toggleMultiSelectValue,
  toggleOrderedMultiSelectValue,
} from "./multi-select";
import { Tabs } from "./tabs";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { DataTableView } from "../data-table/view";
import { setLanguage } from "../../i18n";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setListSelection: ((index: number) => void) | null = null;
let selectedTableRow: string | null = null;
let activatedTableRow: string | null = null;
let tableScrollBoxForTest: ScrollBoxRenderable | null = null;
let tableVisibleRanges: DataTableVisibleRange[] = [];
let setTableVisibleRangeKey: ((key: string) => void) | null = null;
let closedTab: string | null = null;
let addedTab = false;
let resolvedChoice: string | null = null;
let multiSelectOpenStates: boolean[] = [];
const multiSelectDialogHandle = createRef<MultiSelectDialogButtonHandle>();

function ScrollableListHarness() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  setListSelection = setSelectedIndex;

  return (
    <ListView
      items={Array.from({ length: 12 }, (_, index) => ({
        id: `row-${index}`,
        label: `Row ${index + 1}`,
      }))}
      selectedIndex={selectedIndex}
      height={4}
      scrollable
    />
  );
}

function DataTableActivationHarness() {
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <DataTable
      columns={[{ id: "name", label: "NAME", width: 12, align: "left" }]}
      items={[{ id: "alpha", name: "Alpha" }]}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      syncHeaderScroll={() => {}}
      onBodyScrollActivity={() => {}}
      getItemKey={(row) => row.id}
      isSelected={(row) => selectedId === row.id}
      onSelect={(row) => {
        selectedTableRow = row.id;
        setSelectedId(row.id);
      }}
      onActivate={(row) => {
        activatedTableRow = row.id;
      }}
      renderCell={(row) => ({ text: row.name })}
      emptyStateTitle="No rows."
    />
  );
}

type SectionTableRow =
  | { kind: "header"; id: string; label: string }
  | { kind: "row"; id: string; name: string };

function DataTableSectionHarness() {
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows: SectionTableRow[] = [
    { kind: "header", id: "macro", label: "Macro Releases" },
    { kind: "row", id: "cpi", name: "CPI" },
  ];

  return (
    <DataTable
      columns={[{ id: "name", label: "NAME", width: 16, align: "left" }]}
      items={rows}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      syncHeaderScroll={() => {}}
      onBodyScrollActivity={() => {}}
      getItemKey={(row) => row.id}
      isSelected={(row) => row.kind === "row" && row.id === selectedId}
      onSelect={(row) => {
        if (row.kind !== "row") return;
        selectedTableRow = row.id;
        setSelectedId(row.id);
      }}
      renderSectionHeader={(row) => (
        row.kind === "header" ? { text: row.label } : null
      )}
      renderCell={(row) => ({ text: row.kind === "row" ? row.name : "" })}
      emptyStateTitle="No rows."
    />
  );
}

function DataTableHorizontalScrollHarness({
  columns = [{ id: "name", label: "NAME", width: 12, align: "left" }],
  containerWidth = 32,
  containerHeight = 5,
  rowCount = 1,
  columnGap,
  horizontalPadding,
  fillAvailableWidth,
  showHorizontalScrollbar,
}: {
  columns?: DataTableColumn[];
  containerWidth?: number;
  containerHeight?: number;
  rowCount?: number;
  columnGap?: number;
  horizontalPadding?: number;
  fillAvailableWidth?: boolean;
  showHorizontalScrollbar?: boolean;
}) {
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const items = Array.from({ length: rowCount }, (_, index) => ({
    id: `row-${index}`,
    name: index === 0 ? "Alpha" : `Alpha ${index + 1}`,
  }));

  useEffect(() => {
    tableScrollBoxForTest = scrollRef.current;
  });

  return (
    <DataTableView
      rootWidth={containerWidth}
      rootHeight={containerHeight}
      selection={{ kind: "none" }}
      columns={columns}
      items={items}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      getItemKey={(row) => row.id}
      renderCell={(row) => ({ text: row.name })}
      emptyStateTitle="No rows."
      columnGap={columnGap}
      horizontalPadding={horizontalPadding}
      fillAvailableWidth={fillAvailableWidth}
      showHorizontalScrollbar={showHorizontalScrollbar}
    />
  );
}

function DataTableVirtualizationHarness() {
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [visibleRangeKey, setVisibleRangeKey] = useState("first");
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: `row-${index}`,
    name: `Row ${index}`,
  }));

  useEffect(() => {
    tableScrollBoxForTest = scrollRef.current;
    setTableVisibleRangeKey = setVisibleRangeKey;
    return () => {
      if (tableScrollBoxForTest === scrollRef.current) {
        tableScrollBoxForTest = null;
      }
    };
  });

  return (
    <DataTable
      columns={[{ id: "name", label: "NAME", width: 12, align: "left" }]}
      items={rows}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      syncHeaderScroll={() => {}}
      onBodyScrollActivity={() => {}}
      visibleRangeKey={visibleRangeKey}
      onVisibleRangeChange={(range) => tableVisibleRanges.push(range)}
      getItemKey={(row) => row.id}
      isSelected={() => false}
      onSelect={() => {}}
      renderCell={(row) => ({ text: row.name })}
      emptyStateTitle="No rows."
    />
  );
}

function MultiSelectDialogButtonHarness() {
  const [values, setValues] = useState(["sma"]);

  return (
    <TestDialogProvider>
      <MultiSelectDialogButton
        ref={multiSelectDialogHandle}
        label="IND"
        title="Chart Indicators"
        selectedValues={values}
        onChange={setValues}
        idPrefix="indicator-dialog"
        shortcutKey="i"
        shortcutActive
        onOpenChange={(open) => multiSelectOpenStates.push(open)}
        options={[
          { value: "sma", label: "SMA" },
          { value: "ema", label: "EMA" },
        ]}
      />
    </TestDialogProvider>
  );
}

function ChoiceDialogHarness({
  selectedChoiceId,
  choices,
}: {
  selectedChoiceId?: string;
  choices?: Array<{ id: string; label: string; description: string }>;
} = {}) {
  return (
    <ChoiceDialog
      title="Choose Account"
      dismiss={() => {}}
      resolve={(value) => {
        resolvedChoice = value;
      }}
      choices={choices ?? [
        { id: "alpha", label: "Alpha", description: "Alpha account" },
        { id: "beta", label: "Beta", description: "Beta account" },
        { id: "gamma", label: "Gamma", description: "Gamma account" },
      ]}
      selectedChoiceId={selectedChoiceId}
    />
  );
}

async function emitKeypress(event: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }) {
  await act(async () => {
    testSetup!.renderer.keyInput.emit("keypress", {
      ctrl: false,
      meta: false,
      option: false,
      shift: false,
      eventType: "press",
      repeated: false,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...event,
    } as any);
    await Promise.resolve();
    await testSetup!.renderOnce();
    await testSetup!.renderOnce();
  });
  await testSetup!.renderOnce();
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup?.renderer.destroy());
    testSetup = undefined;
  }
  setListSelection = null;
  selectedTableRow = null;
  activatedTableRow = null;
  tableScrollBoxForTest = null;
  tableVisibleRanges = [];
  setTableVisibleRangeKey = null;
  closedTab = null;
  addedTab = false;
  resolvedChoice = null;
  multiSelectOpenStates = [];
  setLanguage("en");
});

describe("shared UI kit", () => {
  test("retranslates stable tab items when the app language changes", async () => {
    const tabs = [{ label: "Open", value: "open" }];
    testSetup = await testRender(
      <Tabs tabs={tabs} activeValue="open" onSelect={() => {}} />,
      { width: 20, height: 2 },
    );

    await act(async () => testSetup?.renderOnce());
    expect(testSetup.captureCharFrame()).toContain("Open");

    await act(async () => {
      setLanguage("zh-CN");
      await testSetup?.renderOnce();
      await testSetup?.renderOnce();
    });

    expect(testSetup.captureCharFrame()).toContain("打开");
  });

  test("scrolls overflowing tabs horizontally with the mouse wheel", async () => {
    testSetup = await testRender(
      <Tabs
        tabs={[
          { label: "Overview", value: "overview" },
          { label: "Financials", value: "financials" },
          { label: "Chart", value: "chart" },
          { label: "Options", value: "options" },
          { label: "Insider", value: "insider" },
        ]}
        activeValue="overview"
        onSelect={() => {}}
      />,
      { width: 24, height: 4 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Overview");
    expect(frame).not.toContain("Insider");

    await act(async () => {
      for (let i = 0; i < 40; i++) {
        await testSetup!.mockMouse.scroll(1, 0, "down");
      }
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Options");
    expect(frame).toContain("Insider");
  });

  test("moves focused tabs with arrow keys and leaves Tab for pane focus", async () => {
    let lastSelected = "overview";
    const selectedValues: string[] = [];

    function KeyboardTabsHarness() {
      const [activeValue, setActiveValue] = useState("overview");
      return (
        <Tabs
          tabs={[
            { label: "Overview", value: "overview" },
            { label: "News", value: "news" },
            { label: "Chart", value: "chart" },
          ]}
          activeValue={activeValue}
          onSelect={(value) => {
            lastSelected = value;
            selectedValues.push(value);
            setActiveValue(value);
          }}
          focused
        />
      );
    }

    testSetup = await testRender(<KeyboardTabsHarness />, { width: 40, height: 4 });

    await act(async () => {
      await testSetup!.renderOnce();
      testSetup!.mockInput.pressArrow("right");
      testSetup!.mockInput.pressArrow("right");
      await testSetup!.renderOnce();
    });

    expect(selectedValues).toEqual(["news", "chart"]);
    expect(lastSelected).toBe("chart");

    await act(async () => {
      testSetup!.mockInput.pressTab();
      await testSetup!.renderOnce();
    });

    expect(lastSelected).toBe("chart");
  });

  test("selects tabs by clicking their text labels", async () => {
    let lastSelected = "overview";
    const selectedValues: string[] = [];

    function PointerTabsHarness() {
      const [activeValue, setActiveValue] = useState("overview");
      return (
        <Tabs
          tabs={[
            { label: "Overview", value: "overview" },
            { label: "News", value: "news" },
            { label: "Chart", value: "chart" },
          ]}
          activeValue={activeValue}
          onSelect={(value) => {
            lastSelected = value;
            selectedValues.push(value);
            setActiveValue(value);
          }}
          scrollable={false}
        />
      );
    }

    testSetup = await testRender(<PointerTabsHarness />, { width: 40, height: 4 });

    await act(async () => {
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
    const newsCol = frame.split("\n")[0]!.indexOf("News");
    expect(newsCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(newsCol + 1, 0);
      await testSetup!.renderOnce();
    });

    expect(lastSelected).toBe("news");

    frame = testSetup.captureCharFrame();
    const chartCol = frame.split("\n")[0]!.indexOf("Chart");
    expect(chartCol).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.click(chartCol + 1, 0);
      await testSetup!.renderOnce();
    });

    expect(selectedValues).toEqual(["news", "chart"]);
    expect(lastSelected).toBe("chart");
  });

  test("renders tab actions for editable tab sets", async () => {
    testSetup = await testRender(
      <Tabs
        tabs={[
          { label: "One", value: "one", onClose: (value) => { closedTab = value; } },
          { label: "Two", value: "two" },
        ]}
        activeValue="one"
        onSelect={() => {}}
        compact
        variant="pill"
        closeMode="active"
        onAdd={() => { addedTab = true; }}
      />,
      { width: 24, height: 3 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("One x");
    expect(frame).toContain("+");

    await act(async () => {
      await testSetup!.mockMouse.click(5, 0);
      await testSetup!.renderOnce();
    });
    expect(closedTab).toBe("one");

    await act(async () => {
      await testSetup!.mockMouse.click(14, 0);
      await testSetup!.renderOnce();
    });
    expect(addedTab).toBe(true);
  });

  test("opens compact multi-select dialogs from a button", async () => {
    testSetup = await testRender(<MultiSelectDialogButtonHarness />, { width: 60, height: 18 });

    await act(async () => {
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("IND: SMA");
    const button = testSetup.renderer.root.findDescendantById("indicator-dialog:button") as BoxRenderable | undefined;
    expect(button).toBeDefined();
    expect(button!.width).toBe(" IND: SMA ".length);

    await act(async () => {
      await testSetup!.mockMouse.release(button!.x + 1, button!.y);
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("Chart Indicators");

    await act(async () => {
      await testSetup!.mockMouse.click(button!.x + 1, button!.y);
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Chart Indicators");
    expect(frame).toContain("[✓] SMA");
    expect(frame).toContain("[ ] EMA");
    expect(frame).not.toContain("Toggle");
    expect(frame).not.toContain("space toggle");

    await act(async () => {
      await testSetup!.mockMouse.click(0, 0);
      await Promise.resolve();
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(frame).not.toContain("Chart Indicators");
  });

  test("opens multi-selects imperatively and only matches plain shortcuts", async () => {
    testSetup = await testRender(<MultiSelectDialogButtonHarness />, { width: 60, height: 18 });

    await act(async () => {
      await testSetup!.renderOnce();
    });

    await emitKeypress({ name: "i", sequence: "i", ctrl: true });
    expect(testSetup.captureCharFrame()).not.toContain("Chart Indicators");

    await emitKeypress({ name: "i", sequence: "i" });
    expect(testSetup.captureCharFrame()).toContain("Chart Indicators");
    expect(multiSelectOpenStates.at(-1)).toBe(true);

    await emitKeypress({ name: "escape", sequence: "\u001b" });
    expect(testSetup.captureCharFrame()).not.toContain("Chart Indicators");
    expect(multiSelectOpenStates.at(-1)).toBe(false);

    await act(async () => {
      multiSelectDialogHandle.current?.open();
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("Chart Indicators");
    expect(multiSelectOpenStates.at(-1)).toBe(true);
  });

  test("supports keyboard and pointer selection in choice dialogs", async () => {
    testSetup = await testRender(<ChoiceDialogHarness />, { width: 44, height: 10 });

    await act(async () => {
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Alpha account");

    await emitKeypress({ name: "down" });
    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Beta account");

    await emitKeypress({ name: "k", sequence: "k" });
    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Alpha account");

    await emitKeypress({ name: "j", sequence: "j" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    expect(resolvedChoice).toBe("beta");

    const gammaRow = testSetup.captureCharFrame().split("\n").findIndex((line) => line.includes("Gamma"));
    expect(gammaRow).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.moveTo(2, gammaRow);
      await testSetup!.renderOnce();
    });
    await testSetup.renderOnce();
    frame = testSetup.captureCharFrame();
    expect(frame).toContain("Gamma account");

    await act(async () => {
      await testSetup!.mockMouse.click(2, gammaRow);
      await testSetup!.renderOnce();
    });
    expect(resolvedChoice).toBe("gamma");
  });

  test("preselects the current choice in choice dialogs", async () => {
    testSetup = await testRender(<ChoiceDialogHarness selectedChoiceId="beta" />, { width: 44, height: 10 });

    await act(async () => {
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Beta account");
    expect(frame).not.toContain("Alpha account");
  });

  test("keeps long choice catalogs bounded and scrolls to the keyboard selection", async () => {
    const choices = Array.from({ length: 20 }, (_, index) => ({
      id: `model-${index + 1}`,
      label: `Model ${index + 1}`,
      description: `Catalog model ${index + 1}`,
    }));
    testSetup = await testRender(<ChoiceDialogHarness choices={choices} />, { width: 44, height: 17 });

    await act(async () => {
      await testSetup!.renderOnce();
    });
    expect(testSetup.captureCharFrame()).not.toContain("Model 20");

    for (let index = 0; index < 19; index += 1) {
      await emitKeypress({ name: "down" });
    }

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Model 20");
    expect(frame).toContain("Catalog model 20");
  });

  test("cancels choice dialogs with escape", async () => {
    testSetup = await testRender(<ChoiceDialogHarness />, { width: 44, height: 10 });

    await act(async () => {
      await testSetup!.renderOnce();
    });
    await emitKeypress({ name: "escape", sequence: "\u001b" });

    expect(resolvedChoice).toBe("");
  });

  test("keeps shared multi-select values in option order when toggling", () => {
    const options = [
      { value: "sma", label: "SMA" },
      { value: "ema", label: "EMA" },
    ];

    expect(toggleMultiSelectValue(options, ["sma"], "ema")).toEqual(["sma", "ema"]);
    expect(toggleMultiSelectValue(options, ["sma", "ema"], "sma")).toEqual(["ema"]);
  });

  test("keeps ordered multi-select values in user order", () => {
    const options = [
      { value: "market", label: "MARKET" },
      { value: "target", label: "TARGET" },
      { value: "venue", label: "VENUE" },
      { value: "odds", label: "TOP ODDS" },
    ];

    expect(normalizeOrderedMultiSelectValues(options, ["venue", "market"])).toEqual(["venue", "market"]);
    expect(toggleOrderedMultiSelectValue(options, ["venue", "market"], "target")).toEqual(["venue", "market", "target"]);

    const displayValues = getMultiSelectDisplayValues(options, ["venue", "market", "target"], true);
    expect(orderMultiSelectOptionsForDisplay(options, displayValues).map((option) => option.value))
      .toEqual(["venue", "market", "target", "odds"]);
    expect(moveMultiSelectDisplayValue(displayValues, ["venue", "market", "target"], "market", "up"))
      .toEqual(["market", "venue", "target", "odds"]);
  });

  test("auto-scrolls a scrollable list to keep the selected row visible", async () => {
    testSetup = await testRender(
      <ScrollableListHarness />,
      { width: 20, height: 6 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });
    await act(async () => {
      setListSelection!(8);
      await Promise.resolve();
    });
    await act(async () => {
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Row 9");
    expect(frame).not.toContain("Row 1");
  });

  test("masks password text fields", async () => {
    testSetup = await testRender(
      <TextField
        type="password"
        value="secret"
        placeholder="Password"
        focused
        width={12}
        onChange={() => {}}
      />,
      { width: 16, height: 3 },
    );

    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("******");
    expect(frame).not.toContain("secret");
  });

  test("does not allow selecting masked password fields", async () => {
    testSetup = await testRender(
      <TextField
        type="password"
        value="secret"
        focused
        width={12}
        onChange={() => {}}
      />,
      { width: 16, height: 3 },
    );

    await testSetup.renderOnce();

    await act(async () => {
      await testSetup!.mockMouse.drag(1, 0, 6, 0);
      await testSetup!.renderOnce();
    });

    expect(testSetup.renderer.getSelection()).toBeNull();
  });

  test("activates data table rows on a second click", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableActivationHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 5 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });
    await act(async () => {
      await testSetup!.mockMouse.click(2, 1);
      await testSetup!.renderOnce();
    });

    expect(selectedTableRow).toBe("alpha");
    expect(activatedTableRow).toBeNull();

    await act(async () => {
      await testSetup!.mockMouse.click(2, 1);
      await testSetup!.renderOnce();
    });

    expect(activatedTableRow).toBe("alpha");
  });

  test("renders data table section headers as non-selectable rows", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableSectionHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 6 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });

    let frame = testSetup.captureCharFrame();
    expect(frame).toContain("Macro Releases");
    expect(frame).toContain("CPI");

    await act(async () => {
      await testSetup!.mockMouse.click(2, 1);
      await testSetup!.renderOnce();
    });
    expect(selectedTableRow).toBeNull();

    await act(async () => {
      await testSetup!.mockMouse.click(2, 2);
      await testSetup!.renderOnce();
    });

    frame = testSetup.captureCharFrame();
    expect(selectedTableRow).toBe("cpi");
    expect(frame).toContain("CPI");
  });

  test("hides data table horizontal scrolling when disabled", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    tableScrollBoxForTest = null;
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableHorizontalScrollHarness showHorizontalScrollbar={false} />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 5 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(tableScrollBoxForTest?.horizontalScrollBar.visible).toBe(false);
  });

  test("hides data table horizontal scrolling when content fits", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    tableScrollBoxForTest = null;
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableHorizontalScrollHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 5 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(tableScrollBoxForTest?.horizontalScrollBar.visible).toBe(false);
  });

  test("shows data table horizontal scrolling when content overflows", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    tableScrollBoxForTest = null;
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableHorizontalScrollHarness
            containerWidth={24}
            columns={[
              { id: "name", label: "NAME", width: 24, align: "left" },
              { id: "price", label: "PRICE", width: 18, align: "right" },
            ]}
          />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 24, height: 5 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(tableScrollBoxForTest?.horizontalScrollBar.visible).toBe(true);
  });

  test("shows data table vertical scrolling when rows overflow", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    tableScrollBoxForTest = null;
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableHorizontalScrollHarness rowCount={20} containerHeight={5} />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 5 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    expect(tableScrollBoxForTest?.verticalScrollBar.visible).toBe(true);
  });

  test("virtualizes data table rows and refreshes after wheel scrolling", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    tableScrollBoxForTest = null;
    testSetup = await testRender(
      <AppContext value={{ state, dispatch: () => {} }}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableVirtualizationHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 6 },
    );

    await act(async () => {
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Row 0");
    expect(frame).not.toContain("Row 99");
    expect(tableScrollBoxForTest?.scrollTop).toBe(0);
    expect(tableVisibleRanges.at(-1)).toEqual({ start: 0, end: 5 });

    const initialRangeCount = tableVisibleRanges.length;
    await act(async () => {
      setTableVisibleRangeKey!("second");
      await Promise.resolve();
      await testSetup!.renderOnce();
    });
    expect(tableVisibleRanges.length).toBeGreaterThan(initialRangeCount);
    expect(tableVisibleRanges.at(-1)).toEqual({ start: 0, end: 5 });

    await act(async () => {
      for (let index = 0; index < 12; index++) {
        await testSetup!.mockMouse.scroll(2, 2, "down");
      }
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await testSetup!.renderOnce();
    });
    await testSetup.renderOnce();

    const scrollTop = tableScrollBoxForTest?.scrollTop ?? 0;
    expect(scrollTop).toBeGreaterThan(0);
    expect(tableVisibleRanges.at(-1)).toEqual({
      start: scrollTop,
      end: Math.min(100, scrollTop + 5),
    });

    const scrolledFrame = testSetup.captureCharFrame();
    expect(scrolledFrame).toContain(`Row ${scrollTop}`);
  });
});
