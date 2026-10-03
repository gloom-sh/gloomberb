import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { afterEach, describe, expect, test } from "bun:test";
import { act, createRef, useEffect, useRef, useState } from "react";
import { setLanguage } from "../../i18n";
import { createOpenTuiTestHarness, TestDialogProvider, type TestKeyEvent } from "../../renderers/opentui/test-utils";
import { Box } from "../../ui";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { ChoiceDialog } from "./choice-dialog";
import { DataTable, type DataTableVisibleRange } from "./data-table";
import { TextField } from "./fields";
import { ListView } from "./list-view";
import {
  getMultiSelectDisplayValues,
  moveMultiSelectDisplayValue,
  normalizeOrderedMultiSelectValues,
  orderMultiSelectOptionsForDisplay,
  toggleMultiSelectValue,
  toggleOrderedMultiSelectValue,
} from "./multi-select";
import { MultiSelectDialogButton, type MultiSelectDialogButtonHandle } from "./multi-select/dialog";
import { SelectButton, type SelectControl } from "./select-button";

const tui = createOpenTuiTestHarness();
let setListSelection: ((index: number) => void) | null = null;
let selectedTableRow: string | null = null;
let activatedTableRow: string | null = null;
let tableScrollBoxForTest: ScrollBoxRenderable | null = null;
let tableVisibleRanges: DataTableVisibleRange[] = [];
let setTableVisibleRangeKey: ((key: string) => void) | null = null;
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

const emitKeypress = (event: TestKeyEvent) => tui.emitKeypress(event, { frames: 2, afterCommit: true });

afterEach(() => {
  setListSelection = null;
  selectedTableRow = null;
  activatedTableRow = null;
  tableScrollBoxForTest = null;
  tableVisibleRanges = [];
  setTableVisibleRangeKey = null;
  resolvedChoice = null;
  multiSelectOpenStates = [];
  setLanguage("en");
});

describe("shared UI kit", () => {
  test("opens compact multi-select dialogs from a button", async () => {
    await tui.render(<MultiSelectDialogButtonHarness />, { width: 60, height: 18 });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    let frame = tui.frame();
    expect(frame).toContain("IND: SMA");
    const button = tui.setup().renderer.root.findDescendantById("indicator-dialog:button") as BoxRenderable | undefined;
    expect(button).toBeDefined();
    expect(button!.width).toBe(" IND: SMA ".length);

    await act(async () => {
      await tui.setup().mockMouse.release(button!.x + 1, button!.y);
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).not.toContain("Chart Indicators");

    await act(async () => {
      await tui.setup().mockMouse.click(button!.x + 1, button!.y);
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).toContain("Chart Indicators");
    expect(frame).toContain("[✓] SMA");
    expect(frame).toContain("[ ] EMA");
    expect(frame).not.toContain("Toggle");
    expect(frame).not.toContain("space toggle");

    await act(async () => {
      await tui.setup().mockMouse.click(0, 0);
      await Promise.resolve();
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(frame).not.toContain("Chart Indicators");
  });

  test("opens multi-selects imperatively and only matches plain shortcuts", async () => {
    await tui.render(<MultiSelectDialogButtonHarness />, { width: 60, height: 18 });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    await emitKeypress({ name: "i", sequence: "i", ctrl: true });
    expect(tui.frame()).not.toContain("Chart Indicators");

    await emitKeypress({ name: "i", sequence: "i" });
    expect(tui.frame()).toContain("Chart Indicators");
    expect(multiSelectOpenStates.at(-1)).toBe(true);

    await emitKeypress({ name: "escape", sequence: "\u001b" });
    expect(tui.frame()).not.toContain("Chart Indicators");
    expect(multiSelectOpenStates.at(-1)).toBe(false);

    await act(async () => {
      multiSelectDialogHandle.current?.open();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("Chart Indicators");
    expect(multiSelectOpenStates.at(-1)).toBe(true);
  });

  test("supports keyboard and pointer selection in choice dialogs", async () => {
    await tui.render(<ChoiceDialogHarness />, { width: 44, height: 10 });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    let frame = tui.frame();
    expect(frame).toContain("Alpha account");

    await emitKeypress({ name: "down" });
    frame = tui.frame();
    expect(frame).toContain("Beta account");

    await emitKeypress({ name: "k", sequence: "k" });
    frame = tui.frame();
    expect(frame).toContain("Alpha account");

    await emitKeypress({ name: "j", sequence: "j" });
    await emitKeypress({ name: "enter", sequence: "\r" });
    expect(resolvedChoice).toBe("beta");

    const gammaRow = tui.frame().split("\n").findIndex((line) => line.includes("Gamma"));
    expect(gammaRow).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await tui.setup().mockMouse.moveTo(2, gammaRow);
      await tui.setup().renderOnce();
    });
    await tui.setup().renderOnce();
    frame = tui.frame();
    expect(frame).toContain("Gamma account");

    await act(async () => {
      await tui.setup().mockMouse.click(2, gammaRow);
      await tui.setup().renderOnce();
    });
    expect(resolvedChoice).toBe("gamma");
  });

  test("preselects the current choice in choice dialogs", async () => {
    await tui.render(<ChoiceDialogHarness selectedChoiceId="beta" />, { width: 44, height: 10 });

    await act(async () => {
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("Beta account");
    expect(frame).not.toContain("Alpha account");
  });

  test("keeps long choice catalogs bounded and scrolls to the keyboard selection", async () => {
    const choices = Array.from({ length: 20 }, (_, index) => ({
      id: `model-${index + 1}`,
      label: `Model ${index + 1}`,
      description: `Catalog model ${index + 1}`,
    }));
    await tui.render(<ChoiceDialogHarness choices={choices} />, { width: 44, height: 17 });

    await act(async () => {
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).not.toContain("Model 20");

    for (let index = 0; index < 19; index += 1) {
      await emitKeypress({ name: "down" });
    }

    const frame = tui.frame();
    expect(frame).toContain("Model 20");
    expect(frame).toContain("Catalog model 20");
  });

  test("cancels choice dialogs with escape", async () => {
    await tui.render(<ChoiceDialogHarness />, { width: 44, height: 10 });

    await act(async () => {
      await tui.setup().renderOnce();
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
    await tui.render(
      <ScrollableListHarness />,
      { width: 20, height: 6 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    await act(async () => {
      setListSelection!(8);
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("Row 9");
    expect(frame).not.toContain("Row 1");
  });

  test("shortens a long list row label instead of running into its detail", async () => {
    await tui.render(
      <Box width={36} height={3}>
        <ListView
          items={[
            { id: "long", label: "Will another result occur for the next Israeli election?", detail: "Polymarket" },
            { id: "short", label: "AAPL · Revenue", detail: "Quarterly" },
          ]}
          selectedIndex={0}
          height={2}
          surface="plain"
        />
      </Box>,
      { width: 36, height: 3 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });

    const [first, second] = tui.frame().split("\n");
    expect(first).toMatch(/^\u25b8 Will .*\.\.\..* Polymarket$/);
    expect(second).toBe("  AAPL · Revenue           Quarterly");
  });

  test("masks password text fields", async () => {
    await tui.render(
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

    await tui.setup().renderOnce();

    const frame = tui.frame();
    expect(frame).toContain("******");
    expect(frame).not.toContain("secret");
  });

  test("a field swapped out after the form clears it does not bring its text back", async () => {
    let clearAndSwap = () => {};
    let latest: Record<"cost" | "ticker", string> = { cost: "", ticker: "" };
    function SwappingForm() {
      const [active, setActive] = useState<"cost" | "ticker">("cost");
      const [values, setValues] = useState({ cost: "", ticker: "" });
      latest = values;
      clearAndSwap = () => {
        setValues({ cost: "", ticker: "" });
        setActive("ticker");
      };
      return (
        <TextField
          key={active}
          value={values[active]}
          focused
          width={12}
          onChange={(next) => setValues((current) => ({ ...current, [active]: next }))}
        />
      );
    }
    await tui.render(<SwappingForm />, { width: 16, height: 2 });
    await act(async () => {
      await tui.setup().mockInput.typeText("180");
      await tui.setup().renderOnce();
    });
    expect(latest.cost).toBe("180");

    // The ticker field takes focus as the cost field leaves; the cost input
    // blurs then and reports the text it still holds.
    await act(async () => {
      clearAndSwap();
      await tui.setup().renderOnce();
    });
    expect(latest).toEqual({ cost: "", ticker: "" });
  });

  test("does not allow selecting masked password fields", async () => {
    await tui.render(
      <TextField
        type="password"
        value="secret"
        focused
        width={12}
        onChange={() => {}}
      />,
      { width: 16, height: 3 },
    );

    await tui.setup().renderOnce();

    await act(async () => {
      await tui.setup().mockMouse.drag(1, 0, 6, 0);
      await tui.setup().renderOnce();
    });

    expect(tui.setup().renderer.getSelection()).toBeNull();
  });

  test("activates data table rows on a second click", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableActivationHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 5 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });
    await act(async () => {
      await tui.setup().mockMouse.click(2, 1);
      await tui.setup().renderOnce();
    });

    expect(selectedTableRow).toBe("alpha");
    expect(activatedTableRow).toBeNull();

    await act(async () => {
      await tui.setup().mockMouse.click(2, 1);
      await tui.setup().renderOnce();
    });

    expect(activatedTableRow).toBe("alpha");
  });

  test("renders data table section headers as non-selectable rows", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableSectionHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 6 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });

    let frame = tui.frame();
    expect(frame).toContain("Macro Releases");
    expect(frame).toContain("CPI");

    await act(async () => {
      await tui.setup().mockMouse.click(2, 1);
      await tui.setup().renderOnce();
    });
    expect(selectedTableRow).toBeNull();

    await act(async () => {
      await tui.setup().mockMouse.click(2, 2);
      await tui.setup().renderOnce();
    });

    frame = tui.frame();
    expect(selectedTableRow).toBe("cpi");
    expect(frame).toContain("CPI");
  });

  test("virtualizes data table rows and refreshes after wheel scrolling", async () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-test"));
    tableScrollBoxForTest = null;
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="portfolio-list:main">
          <DataTableVirtualizationHarness />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 32, height: 6 },
    );

    await act(async () => {
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("Row 0");
    expect(frame).not.toContain("Row 99");
    expect(tableScrollBoxForTest?.scrollTop).toBe(0);
    expect(tableVisibleRanges.at(-1)).toEqual({ start: 0, end: 5 });

    const initialRangeCount = tableVisibleRanges.length;
    await act(async () => {
      setTableVisibleRangeKey!("second");
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
    expect(tableVisibleRanges.length).toBeGreaterThan(initialRangeCount);
    expect(tableVisibleRanges.at(-1)).toEqual({ start: 0, end: 5 });

    await act(async () => {
      for (let index = 0; index < 12; index++) {
        await tui.setup().mockMouse.scroll(2, 2, "down");
      }
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
    await tui.setup().renderOnce();

    const scrollTop = tableScrollBoxForTest?.scrollTop ?? 0;
    expect(scrollTop).toBeGreaterThan(0);
    expect(tableVisibleRanges.at(-1)).toEqual({
      start: scrollTop,
      end: Math.min(100, scrollTop + 5),
    });

    const scrolledFrame = tui.frame();
    expect(scrolledFrame).toContain(`Row ${scrollTop}`);
  });
});


test("a select opened through its handle skips disabled options and ignores results after disabling", async () => {
  const handle = createRef<SelectControl>();
  const changes: string[] = [];
  let disable: (() => void) | undefined;
  function Harness() {
    const [disabled, setDisabled] = useState(false);
    disable = () => setDisabled(true);
    return <TestDialogProvider><SelectButton
      controlRef={handle} label="Account" value="alpha" disabled={disabled}
      options={[{ value: "alpha", label: "Alpha" }, { value: "blocked", label: "Blocked", disabled: true }, { value: "gamma", label: "Gamma" }]}
      onChange={(value) => changes.push(value)}
    /></TestDialogProvider>;
  }
  await tui.render(<Harness />, { width: 44, height: 12 });
  await act(async () => { await tui.setup().renderOnce(); });
  await act(async () => { handle.current!.open(); await tui.setup().renderOnce(); });
  await emitKeypress({ name: "down" });
  await emitKeypress({ name: "enter", sequence: "\r" });
  expect(changes).toEqual(["gamma"]);
  await act(async () => { handle.current?.open(); await tui.setup().renderOnce(); });
  await emitKeypress({ name: "down" });
  await act(async () => { disable?.(); await tui.setup().renderOnce(); });
  await emitKeypress({ name: "enter", sequence: "\r" });
  expect(changes).toEqual(["gamma"]);
});
