import type { ScrollBoxRenderable } from "@opentui/core";
import { expect, test } from "bun:test";
import { act, useRef } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { PaneFocusedProvider } from "../../state/app/activity";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { parseHex } from "../../theme/color-utils";
import { colors, inactiveSelectedBg } from "../../theme/colors";
import { createDefaultConfig } from "../../types/config";
import { DataTable } from "./data-table";
import { ListView } from "./list-view";

const tui = createOpenTuiTestHarness();
const rows = [{ id: "AAPL" }, { id: "MSFT" }];

function Table() {
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  return (
    <DataTable
      columns={[{ id: "name", label: "Name", width: 10, align: "left" }]}
      items={rows}
      sortColumnId={null}
      sortDirection="asc"
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      syncHeaderScroll={() => {}}
      onBodyScrollActivity={() => {}}
      getItemKey={(row) => row.id}
      isSelected={(row) => row.id === "AAPL"}
      onSelect={() => {}}
      renderCell={(row) => ({ text: row.id })}
      emptyStateTitle="No rows."
    />
  );
}

async function selectedRowBg(view: "table" | "list", focused: boolean | null) {
  const body = view === "table"
    ? <Table />
    : <ListView items={rows.map((row) => ({ id: row.id, label: row.id }))} selectedIndex={0} />;
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-selection-fill"));
  await tui.render(
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="selection-fill">
        {focused === null ? body : <PaneFocusedProvider value={focused}>{body}</PaneFocusedProvider>}
      </PaneInstanceProvider>
    </AppContext>,
    { width: 24, height: 6 },
  );
  for (let index = 0; index < 3; index += 1) await act(async () => { await tui.setup().renderOnce(); });
  const line = tui.setup().captureSpans().lines.find((entry) => entry.spans.some((span) => span.text.includes("AAPL")));
  return line?.spans.find((span) => span.text.includes("AAPL"))?.bg.toInts().slice(0, 3);
}

function rgb(hex: string): number[] {
  return [...parseHex(hex)];
}

// Every pane lit its chosen row the same, so nothing said which one the arrows move.
test.each(["table", "list"] as const)("a %s's chosen row is lit in the focused pane, quieter in another, lit outside any pane", async (view) => {
  expect(rgb(colors.selected)).not.toEqual(rgb(inactiveSelectedBg(colors)));
  expect(await selectedRowBg(view, true)).toEqual(rgb(colors.selected));
  expect(await selectedRowBg(view, false)).toEqual(rgb(inactiveSelectedBg(colors)));
  expect(await selectedRowBg(view, null)).toEqual(rgb(colors.selected));
});
