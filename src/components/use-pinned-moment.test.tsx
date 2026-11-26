import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import type { AppState } from "../core/state/app/state";
import { AppContext, PaneInstanceProvider, createInitialState } from "../state/app/context";
import { useTabCursorLink, type TabCursorLink } from "../state/app/tab-cursor";
import { createDefaultConfig } from "../types/config";
import { Box } from "../ui";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "./layout/pane/footer";
import { pinnedMomentFooterSegment, usePinnedList, type PinFollow } from "./use-pinned-moment";

const tui = createOpenTuiTestHarness();

interface Row { id: string; at: string }
const ROWS: Row[] = [
  { id: "a", at: "2026-04-18T12:00:00Z" },
  { id: "b", at: "2026-04-18T14:30:00Z" },
  { id: "c", at: "2026-04-18T16:00:00Z" },
];
const rowId = (row: Row) => row.id;
const rowMoment = (row: Row) => Date.parse(row.at);
const at = (iso: string) => Date.parse(iso);

/** Two layout tabs whose active one the test switches, as the app's tab strip does. */
function createTabsStore() {
  const base = createInitialState(createDefaultConfig("/tmp/gloomberb-pinned-list"));
  const tabs = [{ ...base.config.layouts[0]!, id: "tab-a" }, { ...base.config.layouts[0]!, id: "tab-b" }];
  let state: AppState = { ...base, config: { ...base.config, layouts: tabs, activeLayoutIndex: 0 } };
  const listeners = new Set<() => void>();
  return {
    dispatch: () => {},
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    switchTo(index: number) {
      state = { ...state, config: { ...state.config, activeLayoutIndex: index } };
      for (const listener of listeners) listener();
    },
  };
}

describe("a list following the tab's pinned crosshair", () => {
  // The selection is the user's between pin moves: a row streaming in, a row
  // picked by hand and lifting the pin all leave it where it is.
  test("selects the newest row out by the pin when it moves, never when a row streams in, and keeps a hand-picked row through unpinning", async () => {
    let link: TabCursorLink | undefined;
    let follow!: PinFollow<Row>;
    let selected: string | null = "c";
    let pick!: (id: string) => void;
    let stream!: (rows: Row[]) => void;
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function List() {
      const [rows, setRows] = useState(ROWS);
      const [selectedId, setSelectedId] = useState<string | null>("c");
      selected = selectedId;
      pick = setSelectedId;
      stream = setRows;
      follow = usePinnedList<Row>("test-list:pin", { rows, getId: rowId, moment: rowMoment, selectedId, select: setSelectedId });
      return null;
    }
    const store = createTabsStore();
    await tui.render(
      <AppContext value={store}>
        <PaneInstanceProvider paneId="chart:one"><Chart /></PaneInstanceProvider>
        <PaneInstanceProvider paneId="list:one"><List /></PaneInstanceProvider>
      </AppContext>,
    );
    try {
      await act(async () => link!.pin!(at("2026-04-18T15:00:00Z")));
      expect(selected).toBe("b");
      expect(ROWS.map((row) => follow.isAfterPin(row))).toEqual([false, false, true]);

      await act(async () => stream([...ROWS, { id: "streamed", at: "2026-04-18T14:45:00Z" }]));
      expect(selected).toBe("b");

      await act(async () => pick("c"));
      await act(async () => stream([...ROWS, { id: "later", at: "2026-04-18T14:50:00Z" }]));
      expect(selected).toBe("c");

      // The pin moving takes the selection with it again.
      await act(async () => link!.pin!(at("2026-04-18T13:00:00Z")));
      expect(selected).toBe("a");

      await act(async () => pick("c"));
      await act(async () => link!.pin!(null));
      expect(selected).toBe("c");
      expect(follow.isAfterPin(ROWS[2]!)).toBe(false);
    } finally {
      await act(async () => link?.pin?.(null));
    }
  });

  test("a pin before every row selects the earliest row, not the row an earlier pin picked", async () => {
    let link: TabCursorLink | undefined;
    let follow!: PinFollow<Row>;
    let selected: string | null = null;
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function List() {
      const [selectedId, setSelectedId] = useState<string | null>("c");
      selected = selectedId;
      follow = usePinnedList<Row>("test-list:pin", { rows: ROWS, getId: rowId, moment: rowMoment, selectedId, select: setSelectedId });
      return null;
    }
    await tui.render(
      <AppContext value={createTabsStore()}>
        <PaneInstanceProvider paneId="chart:two"><Chart /></PaneInstanceProvider>
        <PaneInstanceProvider paneId="list:two"><List /></PaneInstanceProvider>
      </AppContext>,
    );
    try {
      await act(async () => link!.pin!(at("2026-04-18T15:00:00Z")));
      expect([selected, follow.beforeRows]).toEqual(["b", false]);
      await act(async () => link!.pin!(at("2026-04-18T11:00:00Z")));
      expect([selected, follow.beforeRows]).toEqual(["a", true]);
      expect(ROWS.every((row) => follow.isAfterPin(row))).toBe(true);
    } finally {
      await act(async () => link?.pin?.(null));
    }
  });

  // Switching tabs unmounts the panes of the one left. Back on it, a list
  // that kept its selection keeps the row picked there under the same pin;
  // one that lost it follows the pin again. Another tab's list never follows.
  test("a list back from another tab keeps the row picked under the same pin, and the other tab's list never follows it", async () => {
    let link: TabCursorLink | undefined;
    let saved: string | null = "c";
    let shown: { tab: "a" | "b"; mounted: boolean } = { tab: "a", mounted: true };
    let rerender!: () => void;
    let pick!: (id: string) => void;
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function List() {
      // The pane's own state, kept while it is not mounted (as pane state is).
      const [selectedId, setSelectedId] = useState<string | null>(saved);
      const select = (id: string) => { saved = id; setSelectedId(id); };
      pick = select;
      usePinnedList<Row>("test-list:pin", { rows: ROWS, getId: rowId, moment: rowMoment, selectedId, select });
      return null;
    }
    function Tabs() {
      const [, setTick] = useState(0);
      rerender = () => setTick((tick) => tick + 1);
      return <>
        <PaneInstanceProvider paneId="chart:three"><Chart /></PaneInstanceProvider>
        {shown.mounted ? <PaneInstanceProvider key={shown.tab} paneId={`list:${shown.tab}`}><List /></PaneInstanceProvider> : null}
      </>;
    }
    const store = createTabsStore();
    await tui.render(<AppContext value={store}><Tabs /></AppContext>);
    const show = async (next: typeof shown) => {
      shown = next;
      await act(async () => rerender());
    };
    try {
      await act(async () => link!.pin!(at("2026-04-18T15:00:00Z")));
      expect(saved).toBe("b");
      await act(async () => pick("c"));

      await show({ tab: "a", mounted: false });
      await act(async () => store.switchTo(1));
      saved = "a";
      await show({ tab: "b", mounted: true });
      expect(saved).toBe("a");

      await show({ tab: "b", mounted: false });
      await act(async () => store.switchTo(0));
      saved = "c";
      await show({ tab: "a", mounted: true });
      expect(saved).toBe("c");

      // A list that comes back with no row of its own goes to the pin's.
      await show({ tab: "a", mounted: false });
      saved = null;
      await show({ tab: "a", mounted: true });
      expect(saved).toBe("b");
    } finally {
      await act(async () => link?.pin?.(null));
    }
  });

  // The footer says so in every follower, focused or not, but only the
  // focused pane binds Esc to lift it.
  test("an unfocused follower names the pin in its footer without taking Esc, and the focused one offers [Esc]unpin", async () => {
    let link: TabCursorLink | undefined;
    let setFocused!: (focused: boolean) => void;
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function List() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      usePinnedList<Row>("test-list:pin", { rows: ROWS, getId: rowId, moment: rowMoment, selectedId, select: setSelectedId });
      return null;
    }
    function Pane() {
      const [focused, set] = useState(false);
      setFocused = set;
      return <PaneFooterProvider>{(footer) => (
        <Box width={70} height={2} flexDirection="column">
          <List />
          <PaneFooterBar footer={footer} focused={focused} width={70} />
          <PaneFooterKeys paneId="list:four" footer={footer} focused={focused} />
        </Box>
      )}</PaneFooterProvider>;
    }
    const pinAt = at("2026-04-18T15:00:00Z");
    await tui.render(
      <AppContext value={createTabsStore()}>
        <PaneInstanceProvider paneId="chart:four"><Chart /></PaneInstanceProvider>
        <PaneInstanceProvider paneId="list:four"><Pane /></PaneInstanceProvider>
      </AppContext>,
      { width: 70, height: 2 },
    );
    const settle = () => act(async () => { await tui.setup().renderOnce(); });
    const escape = () => tui.emitKeypress({ name: "escape", sequence: "\u001b" }, { frames: 2, afterCommit: true });
    try {
      await act(async () => link!.pin!(pinAt));
      await settle();
      const status = pinnedMomentFooterSegment(pinAt).parts[0]!.text;
      expect(tui.frame()).toContain(status);
      expect(tui.frame()).not.toContain("unpin");
      await escape();
      expect(link!.pinned!()).toBe(true);

      await act(async () => setFocused(true));
      await settle();
      expect(tui.frame()).toContain(status);
      expect(tui.frame()).toContain("unpin");
      await escape();
      expect(link!.pinned!()).toBe(false);
    } finally {
      await act(async () => link?.pin?.(null));
    }
  });

  test("names the pin on one clock with its zone said, the day first and the year only when it is not this one", () => {
    const pinAt = at("2026-04-18T14:30:00Z");
    const text = (now: string, zone: string) => pinnedMomentFooterSegment(pinAt, at(now), zone).parts[0]!.text;
    expect(text("2026-04-20T00:00:00Z", "America/New_York")).toBe("pinned 18 Apr 10:30 ET");
    expect(text("2026-04-20T00:00:00Z", "Asia/Hong_Kong")).toBe("pinned 18 Apr 22:30 HKT");
    expect(text("2027-01-04T00:00:00Z", "UTC")).toBe("pinned 18 Apr 2026 14:30 UTC");
  });
});
