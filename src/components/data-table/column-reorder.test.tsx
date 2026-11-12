import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState, type AppContextStoreValue } from "../../state/app/context";
import { createReducerAppStore } from "../../test-support/app-store";
import { createTestPaneConfig } from "../../test-support/pane";
import { findPaneInstance } from "../../types/config";
import type { ContextMenuItem } from "../../types/context-menu";
import { Box } from "../../ui";
import { PaneFooterProvider } from "../layout/pane/footer";
import type { DataTableColumn, DataTableProps } from "../ui";
import { COLUMN_ORDER_SETTING } from "../ui/data-table/column-order";
import { DataTableView } from "./view";

const PANE = "quotes:1";
const COLUMNS: DataTableColumn[] = [
  { id: "ticker", label: "TICKER", width: 8, align: "left" },
  { id: "price", label: "LAST", width: 8, align: "right" },
  { id: "change", label: "CHG%", width: 8, align: "right" },
  { id: "volume", label: "VOL", width: 8, align: "right" },
];
const ROWS = [
  { id: "AAPL", price: "201.50", change: "+1.2%", volume: "52.1M" },
  { id: "MSFT", price: "420.10", change: "-0.4%", volume: "18.3M" },
];

const tui = createOpenTuiTestHarness({ width: 60, height: 8 });

function newStore(settings?: Record<string, unknown>): AppContextStoreValue {
  const config = createTestPaneConfig(":memory:", { instanceId: PANE, paneId: "quotes", settings });
  return createReducerAppStore(createInitialState(config));
}

function savedOrder(store: AppContextStoreValue) {
  return findPaneInstance(store.getState().config.layout, PANE)?.settings?.[COLUMN_ORDER_SETTING];
}

async function renderTable(store: AppContextStoreValue, props: Partial<DataTableProps<typeof ROWS[number]>> = {}) {
  const menu: { items: ContextMenuItem[] } = { items: [] };
  const sorted: string[] = [];
  await tui.render(
    <AppContext value={store}>
      <PaneInstanceProvider paneId={PANE}>
        <PaneFooterProvider>{(footer) => {
          menu.items = footer.menu;
          return (
            <Box width={60} height={8}>
              <DataTableView
                focused
                columns={COLUMNS}
                items={ROWS}
                getItemKey={(row) => row.id}
                selection={{ kind: "none" }}
                sortColumnId={null}
                sortDirection="asc"
                onHeaderClick={(columnId) => sorted.push(columnId)}
                emptyStateTitle="No quotes."
                renderCell={(row, column) => ({ text: column.id === "ticker" ? row.id : row[column.id as "price"] })}
                {...props}
              />
            </Box>
          );
        }}</PaneFooterProvider>
      </PaneInstanceProvider>
    </AppContext>,
  );
  await tui.waitForFrameToContain("AAPL");
  return { menu, sorted };
}

function headerLine(): string {
  return tui.frame().split("\n")[0]!.trim().replace(/\s+/g, " ");
}

/** Where a header label starts in the frame. */
function labelX(label: string): number {
  return tui.frame().split("\n")[0]!.indexOf(label);
}

/** Presses on a header label and lets go `cells` to its side. */
async function dragHeader(label: string, cells: number) {
  const renderer = tui.setup();
  const x = labelX(label) + 1;
  await act(async () => {
    await renderer.mockMouse.drag(x, 0, Math.max(0, x + cells), 0);
    await renderer.renderOnce();
  });
  await tui.renderFrames();
}

test("dragging a header moves its column, remembers it in the pane's settings, and opens that way again", async () => {
  const store = newStore();
  const { sorted } = await renderTable(store);
  expect(headerLine()).toBe("TICKER LAST CHG% VOL");

  await dragHeader("VOL", labelX("TICKER") + 5 - labelX("VOL"));
  expect(headerLine()).toBe("TICKER VOL LAST CHG%");
  expect(sorted).toEqual([]);
  expect(savedOrder(store)).toEqual({ ticker: ["ticker", "volume", "price", "change"] });

  // A restart reads the saved layout: the table opens in the reader's order.
  const reopened = newStore(findPaneInstance(store.getState().config.layout, PANE)?.settings);
  await renderTable(reopened);
  expect(headerLine()).toBe("TICKER VOL LAST CHG%");
});

test("a click, or a press that moves less than the threshold, sorts instead of moving", async () => {
  const store = newStore();
  const { sorted } = await renderTable(store);
  await tui.clickFrameText("CHG%");
  await dragHeader("LAST", 1);
  expect(sorted).toEqual(["change", "price"]);
  expect(headerLine()).toBe("TICKER LAST CHG% VOL");
  expect(savedOrder(store)).toBeUndefined();
});

test("the row's name stays first: it does not drag and nothing drops before it", async () => {
  const store = newStore();
  const { sorted } = await renderTable(store);
  await dragHeader("TICKER", 12);
  expect(headerLine()).toBe("TICKER LAST CHG% VOL");
  await dragHeader("CHG%", -labelX("CHG%"));
  expect(headerLine()).toBe("TICKER CHG% LAST VOL");
  expect(sorted).toEqual(["ticker"]);
});

test("Reset Columns in the pane menu puts the pane's own order back", async () => {
  const store = newStore({ [COLUMN_ORDER_SETTING]: { ticker: ["ticker", "change", "volume", "price"] } });
  const { menu } = await renderTable(store);
  expect(headerLine()).toBe("TICKER CHG% VOL LAST");
  const reset = menu.items.find((item) => item.type !== "divider" && item.id === "reset-columns");
  expect(reset && reset.type !== "divider" && reset.type !== "role" ? reset.label : null).toBe("Reset Columns");

  await act(async () => {
    if (reset && reset.type !== "divider" && reset.type !== "role") await reset.onSelect?.();
  });
  await tui.renderFrames();
  expect(headerLine()).toBe("TICKER LAST CHG% VOL");
  expect(savedOrder(store)).toBeUndefined();
  expect(menu.items.some((item) => item.type !== "divider" && item.id === "reset-columns")).toBe(false);
});

test("a table that opts out keeps its order and sorts on the press", async () => {
  const store = newStore({ [COLUMN_ORDER_SETTING]: { ticker: ["ticker", "volume", "price", "change"] } });
  const { sorted } = await renderTable(store, { columnReorder: false });
  expect(headerLine()).toBe("TICKER LAST CHG% VOL");
  await dragHeader("VOL", labelX("TICKER") + 5 - labelX("VOL"));
  expect(headerLine()).toBe("TICKER LAST CHG% VOL");
  expect(sorted).toEqual(["volume"]);
});

test("a pane whose settings order its columns gets its own list back, with the columns it hides and none it adds", async () => {
  const changes: string[][] = [];
  // The pane's list also has NAME, which it drops at this width, and the table shows CHG% it adds on its own.
  const order = ["ticker", "price", "name", "volume"];
  await renderTable(newStore(), {
    columnReorder: { control: { order, defaultOrder: order, onChange: (next) => changes.push(next) } },
  });
  await dragHeader("VOL", labelX("TICKER") + 5 - labelX("VOL"));
  expect(changes).toEqual([["ticker", "volume", "price", "name"]]);
});
