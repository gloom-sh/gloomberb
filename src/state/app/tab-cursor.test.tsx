import { describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { createDefaultConfig } from "../../types/config";
import type { AppState } from "../../core/state/app/state";
import { AppContext, createInitialState, PaneInstanceProvider } from "./context";
import { useTabCursorLink, type TabCursorLink } from "./tab-cursor";

const tui = createOpenTuiTestHarness();

describe("a pinned tab cursor", () => {
  // The pin is the tab's: closing the chart it came from, a chart whose pane
  // stays open (reloading) or switching tabs keeps it, and only the last
  // chart closing in the open tab lifts it. All of that is read after the
  // commit, from the app's state at that moment.
  test("goes when the last chart in the open tab closes, and not before", async () => {
    const base = createInitialState(createDefaultConfig("/tmp/gloomberb-tab-cursor-pin"));
    const tabs = [{ ...base.config.layouts[0]!, id: "tab-a" }, { ...base.config.layouts[0]!, id: "tab-b" }];
    let state: AppState = { ...base, config: { ...base.config, layouts: tabs, activeLayoutIndex: 0 } };
    const store = { dispatch: () => {}, getState: () => state, subscribe: () => () => {} };
    const openPane = state.config.layout.instances[0]!.instanceId;
    const links: Record<string, TabCursorLink | undefined> = {};
    let show: (charts: string[]) => void = () => {};
    function Chart({ id }: { id: string }) {
      links[id] = useTabCursorLink(id);
      return null;
    }
    function Charts() {
      const [charts, setCharts] = useState(["closed-a", "open"]);
      show = setCharts;
      return charts.map((id) => id === "open"
        ? <PaneInstanceProvider key={id} paneId={openPane}><Chart id={id} /></PaneInstanceProvider>
        : <PaneInstanceProvider key={id} paneId={`gone:${id}`}><Chart id={id} /></PaneInstanceProvider>);
    }
    await tui.render(<AppContext value={store}><Charts /></AppContext>);
    const settle = () => act(async () => {
      await tui.setup().renderOnce();
      await Promise.resolve();
    });

    await act(async () => links["closed-a"]!.pin!(Date.parse("2026-10-16T16:00:00Z")));
    // A time no Date holds changes nothing.
    await act(async () => links["closed-a"]!.pin!(Number.NaN));
    expect(links.open!.pinned!()).toBe(true);

    // The chart it was pinned on closes; another is still there.
    await act(async () => show(["open"]));
    await settle();
    expect(links.open!.pinned!()).toBe(true);
    // The last chart unmounts, but its pane is still in the layout.
    await act(async () => show([]));
    await settle();
    expect(links.open!.pinned!()).toBe(true);
    // Every chart unmounts because the user switched tabs.
    await act(async () => show(["closed-b"]));
    await settle();
    state = { ...state, config: { ...state.config, activeLayoutIndex: 1 } };
    await act(async () => show([]));
    await settle();
    state = { ...state, config: { ...state.config, activeLayoutIndex: 0 } };
    await act(async () => show(["closed-b"]));
    await settle();
    expect(links["closed-b"]!.pinned!()).toBe(true);
    // The last chart in the open tab closes.
    await act(async () => show([]));
    await settle();
    expect(links["closed-b"]!.pinned!()).toBe(false);
  });
  // Tabs without an id are keyed by their place. Closing one must not leave
  // its pin there for the tab that moves into that place, and a tab that
  // moves keeps its own.
  test("a closed tab's pin goes with it, and the tabs that move up keep their own", async () => {
    const base = createInitialState(createDefaultConfig("/tmp/gloomberb-tab-cursor-close"));
    const tab = (name: string) => ({ ...base.config.layouts[0]!, id: undefined, name });
    let state: AppState = { ...base, config: { ...base.config, layouts: [tab("A"), tab("B"), tab("C")], activeLayoutIndex: 1 } };
    const listeners = new Set<() => void>();
    const store = {
      dispatch: () => {},
      getState: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const update = (next: AppState) => { state = next; for (const listener of listeners) listener(); };
    const openPane = state.config.layout.instances[0]!.instanceId;
    let link: TabCursorLink | undefined;
    let show: (visible: boolean) => void = () => {};
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    function Tab() {
      const [visible, setVisible] = useState(true);
      show = setVisible;
      return visible ? <PaneInstanceProvider paneId={openPane}><Chart /></PaneInstanceProvider> : null;
    }
    await tui.render(<AppContext value={store}><Tab /></AppContext>);
    const settle = () => act(async () => {
      await tui.setup().renderOnce();
      await Promise.resolve();
    });
    const switchTo = async (index: number) => {
      await act(async () => show(false));
      await settle();
      await act(async () => update({ ...state, config: { ...state.config, activeLayoutIndex: index } }));
      await act(async () => show(true));
      await settle();
    };

    const atB = Date.parse("2026-10-16T14:00:00Z");
    const atC = Date.parse("2026-10-16T15:00:00Z");
    await act(async () => link!.pin!(atB));
    await switchTo(2);
    await act(async () => link!.pin!(atC));
    // B closes while C is open: C moves up to B's place and keeps its pin.
    await act(async () => update({ ...state, config: { ...state.config, layouts: [tab("A"), tab("C")], activeLayoutIndex: 1 } }));
    await settle();
    expect([link!.pinned!(), link!.time()]).toEqual([true, atC]);
    // A new tab in C's old place starts unpinned, and so does A.
    await act(async () => update({ ...state, config: { ...state.config, layouts: [tab("A"), tab("C"), tab("D")] } }));
    await switchTo(2);
    expect(link!.pinned!()).toBe(false);
    await switchTo(0);
    expect(link!.pinned!()).toBe(false);
    await switchTo(1);
    await act(async () => link!.pin!(null));
  });
});
