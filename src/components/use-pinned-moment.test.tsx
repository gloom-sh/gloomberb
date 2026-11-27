import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import type { AppState } from "../core/state/app/state";
import { AppContext, PaneInstanceProvider, createInitialState } from "../state/app/context";
import { useTabCursorLink, type TabCursorLink } from "../state/app/tab-cursor";
import { createDefaultConfig } from "../types/config";
import { Box } from "../ui";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "./layout/pane/footer";
import { pinFollowersForTests, pinnedMomentFooterSegment, usePinnedList, type PinFollow } from "./use-pinned-moment";

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

/**
 * Two layout tabs holding the given panes, whose active one the test
 * switches, and whose panes it opens and closes, as the app does: the active
 * tab's panes are the app's layout, and a tab switched away from keeps its own.
 */
function createTabsStore(panes: [string[], string[]] = [[], []]) {
  const base = createInitialState(createDefaultConfig("/tmp/gloomberb-pinned-list"));
  const layoutOf = (ids: string[]) => ({ ...base.config.layout, instances: ids.map((instanceId) => ({ instanceId, paneId: "test-list" })) });
  const tabs = panes.map((ids, index) => ({ ...base.config.layouts[0]!, id: `tab-${"ab"[index]}`, layout: layoutOf(ids) }));
  let state: AppState = { ...base, config: { ...base.config, layouts: tabs, layout: tabs[0]!.layout, activeLayoutIndex: 0 } };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const setPanes = (ids: (current: string[]) => string[]) => {
    const { activeLayoutIndex, layouts } = state.config;
    const layout = layoutOf(ids(state.config.layout.instances.map((instance) => instance.instanceId)));
    state = { ...state, config: { ...state.config, layout, layouts: layouts.map((tab, index) => index === activeLayoutIndex ? { ...tab, layout } : tab) } };
    notify();
  };
  return {
    dispatch: () => {},
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    switchTo(index: number) {
      state = { ...state, config: { ...state.config, activeLayoutIndex: index, layout: state.config.layouts[index]!.layout } };
      notify();
    },
    open: (paneId: string) => setPanes((ids) => [...ids, paneId]),
    close: (paneId: string) => setPanes((ids) => ids.filter((id) => id !== paneId)),
  };
}

/** Lets the checks queued when a pane unmounts run. */
const unmountSettled = () => act(async () => { await Promise.resolve(); });

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
  // The tab switches and its panes unmount in one update, as in the app.
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
    const store = createTabsStore([["chart:three", "list:a"], ["list:b"]]);
    await tui.render(<AppContext value={store}><Tabs /></AppContext>);
    const show = async (next: typeof shown) => {
      shown = next;
      await act(async () => rerender());
      await unmountSettled();
    };
    const switchTo = async (index: number) => {
      shown = { tab: shown.tab, mounted: false };
      await act(async () => {
        store.switchTo(index);
        rerender();
      });
      await unmountSettled();
    };
    try {
      await act(async () => link!.pin!(at("2026-04-18T15:00:00Z")));
      const pin = link!.pinnedMoment!()!;
      expect(saved).toBe("b");
      await act(async () => pick("c"));

      await switchTo(1);
      saved = "a";
      await show({ tab: "b", mounted: true });
      expect(saved).toBe("a");

      await switchTo(0);
      expect(pinFollowersForTests(pin)).toBe(1);
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

  // What a list followed is kept with the pin, so a pin moved or lifted
  // drops it; a pane closed under the pin drops its own entry, so opening and
  // closing panes leaves nothing behind, and a pane opened again follows anew.
  test("a pane closed under the pin forgets what its list followed, through repeated open, pin and close", async () => {
    let link: TabCursorLink | undefined;
    let selected: string | null = null;
    let pick!: (id: string) => void;
    let showPanes!: (ids: string[]) => void;
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function List() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      selected = selectedId;
      pick = setSelectedId;
      usePinnedList<Row>("test-list:pin", { rows: ROWS, getId: rowId, moment: rowMoment, selectedId, select: setSelectedId });
      return null;
    }
    function Panes() {
      const [ids, setIds] = useState<string[]>([]);
      showPanes = setIds;
      return <>
        <PaneInstanceProvider paneId="chart:five"><Chart /></PaneInstanceProvider>
        {ids.map((id) => <PaneInstanceProvider key={id} paneId={id}><List /></PaneInstanceProvider>)}
      </>;
    }
    const store = createTabsStore([["chart:five"], []]);
    await tui.render(<AppContext value={store}><Panes /></AppContext>);
    const open = async (id: string) => {
      await act(async () => store.open(id));
      await act(async () => showPanes([id]));
    };
    const close = async (id: string) => {
      await act(async () => store.close(id));
      await act(async () => showPanes([]));
      await unmountSettled();
    };
    try {
      for (const [index, hour] of ["13", "15", "17"].entries()) {
        await open(`list:cycle-${index}`);
        await act(async () => link!.pin!(at(`2026-04-18T${hour}:00:00Z`)));
        const pin = link!.pinnedMoment!()!;
        expect(pinFollowersForTests(pin)).toBe(1);
        await act(async () => pick("a"));
        await close(`list:cycle-${index}`);
        expect(pinFollowersForTests(pin)).toBe(0);
      }

      // The same pane opened again under the same pin follows it, as any new pane does.
      await open("list:again");
      await act(async () => link!.pin!(at("2026-04-18T15:00:00Z")));
      await act(async () => pick("c"));
      await close("list:again");
      await open("list:again");
      expect(selected).toBe("b");
    } finally {
      await act(async () => link?.pin?.(null));
    }
  });

  // A list can stop following while its pane stays open (FLOW's Tide tab, a
  // folded chart) and then close: its entry goes with the pane all the same,
  // so under one pin that never moves, opening and closing panes leaves the
  // count where it was, whichever way each list closed.
  test("under one pin, a pane that stopped following before it closed still drops its entry", async () => {
    let link: TabCursorLink | undefined;
    let pick!: (id: string) => void;
    let setFollows!: (follows: boolean) => void;
    let showPanes!: (ids: string[]) => void;
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function List() {
      const [selectedId, setSelectedId] = useState<string | null>(null);
      const [follows, set] = useState(true);
      pick = setSelectedId;
      setFollows = set;
      usePinnedList<Row>("test-list:pin", { follows, rows: ROWS, getId: rowId, moment: rowMoment, selectedId, select: setSelectedId });
      return null;
    }
    function Panes() {
      const [ids, setIds] = useState<string[]>(["list:resident"]);
      showPanes = setIds;
      return <>
        <PaneInstanceProvider paneId="chart:seven"><Chart /></PaneInstanceProvider>
        {ids.map((id) => <PaneInstanceProvider key={id} paneId={id}><List /></PaneInstanceProvider>)}
      </>;
    }
    const store = createTabsStore([["chart:seven", "list:resident"], []]);
    await tui.render(<AppContext value={store}><Panes /></AppContext>);
    try {
      await act(async () => link!.pin!(at("2026-04-18T15:00:00Z")));
      const pin = link!.pinnedMoment!()!;
      // The resident list followed it and stays open throughout.
      const baseline = pinFollowersForTests(pin);
      expect(baseline).toBe(1);
      for (const [index, stopsFirst] of [true, false, true, true].entries()) {
        const id = `list:closing-${index}`;
        await act(async () => store.open(id));
        await act(async () => showPanes(["list:resident", id]));
        expect(pinFollowersForTests(pin)).toBe(baseline + 1);
        await act(async () => pick("c"));
        if (stopsFirst) await act(async () => setFollows(false));
        expect(pinFollowersForTests(pin)).toBe(baseline + 1);
        await act(async () => store.close(id));
        await act(async () => showPanes(["list:resident"]));
        await unmountSettled();
        expect(link!.pinnedMoment!()).toBe(pin);
        expect(pinFollowersForTests(pin)).toBe(baseline);
      }
    } finally {
      await act(async () => link?.pin?.(null));
    }
  });

  // An unpinned list follows nothing, so it never looks through its rows for
  // the selection or the pin's row, however often it renders.
  test("an unpinned list reads no row while it renders", async () => {
    let link: TabCursorLink | undefined;
    let reads = 0;
    let stream!: (rows: Row[]) => void;
    const countedId = (row: Row) => { reads += 1; return row.id; };
    const countedMoment = (row: Row) => { reads += 1; return rowMoment(row); };
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function List() {
      const [rows, setRows] = useState(ROWS);
      const [selectedId, setSelectedId] = useState<string | null>("c");
      stream = setRows;
      usePinnedList<Row>("test-list:pin", { rows, getId: countedId, moment: countedMoment, selectedId, select: setSelectedId });
      return null;
    }
    await tui.render(
      <AppContext value={createTabsStore([["chart:six", "list:six"], []])}>
        <PaneInstanceProvider paneId="chart:six"><Chart /></PaneInstanceProvider>
        <PaneInstanceProvider paneId="list:six"><List /></PaneInstanceProvider>
      </AppContext>,
    );
    try {
      for (const id of ["d", "e", "f"]) await act(async () => stream([...ROWS, { id, at: "2026-04-18T17:00:00Z" }]));
      expect(reads).toBe(0);

      await act(async () => link!.pin!(at("2026-04-18T15:00:00Z")));
      expect(reads).toBeGreaterThan(0);

      await act(async () => link!.pin!(null));
      reads = 0;
      for (const id of ["g", "h"]) await act(async () => stream([...ROWS, { id, at: "2026-04-18T17:00:00Z" }]));
      expect(reads).toBe(0);
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
