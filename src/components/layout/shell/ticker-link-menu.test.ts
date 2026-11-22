import { describe, expect, test } from "bun:test";
import { appReducer, createInitialState } from "../../../state/app/context";
import {
  createDefaultConfig,
  createPaneInstance,
  findPaneInstance,
  removePaneInstances,
  TICKER_RESEARCH_PANE_ID,
  type LayoutConfig,
} from "../../../types/config";
import type { PaneDef } from "../../../types/plugin";
import { sanitizeLayout } from "../../../data/config/layout";
import { resolveTickerActivation } from "../../../layout/ticker-navigation";
import { retargetTickerPane } from "../../../layout/ticker-retarget";
import { getPaneDisplayTitle } from "../pane/title";
import { tickerLinkMenuItems } from "./ticker-link-menu";
import { buildQuoteMonitorPaneTitle } from "../../../plugins/builtin/ticker-detail/settings";

const panes = new Map<string, PaneDef>([
  ["portfolio-list", {
    id: "portfolio-list",
    name: "Portfolio",
    component: () => null,
    defaultPosition: "left",
    tickerSource: true,
  }],
  [TICKER_RESEARCH_PANE_ID, {
    id: TICKER_RESEARCH_PANE_ID,
    name: "Ticker Research",
    component: () => null,
    defaultPosition: "right",
  }],
  ["options-positioning", {
    id: "options-positioning",
    name: "Options Positioning",
    component: () => null,
    defaultPosition: "right",
    tickerFollower: true,
  }],
  ["options", { id: "options", name: "Options", component: () => null, defaultPosition: "right", tickerFollower: true }],
  ["vol-surface", { id: "vol-surface", name: "Volatility Surface", component: () => null, defaultPosition: "right" }],
  ["notes", { id: "notes", name: "Notes", component: () => null, defaultPosition: "right" }],
]);

describe("tickerLinkMenuItems", () => {
  test("pins the current ticker when unlinking and can link back to the source", () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-link-menu-test"));
    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "AAPL" };
    const target = findPaneInstance(state.config.layout, "ticker-detail:main")!;
    let layout: LayoutConfig = state.config.layout;

    expect(getPaneDisplayTitle(state, target, panes.get(TICKER_RESEARCH_PANE_ID)!, panes)).toBe(
      "AAPL  ⧉ Linked to Main Portfolio",
    );

    tickerLinkMenuItems({
      instance: target,
      layout,
      panes,
      state,
      persistLayout: (nextLayout) => { layout = nextLayout; },
    }).find((item) => item.id === "unlink:portfolio-list:main")?.onSelect?.();

    const pinned = findPaneInstance(layout, target.instanceId)!;
    expect(pinned.binding).toEqual({ kind: "fixed", symbol: "AAPL" });

    const previousFollower = createPaneInstance(TICKER_RESEARCH_PANE_ID, {
      instanceId: "ticker-detail:previous",
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
    });
    layout = {
      ...layout,
      instances: [...layout.instances, previousFollower],
      floating: [
        ...layout.floating,
        { instanceId: previousFollower.instanceId, x: 1, y: 1, width: 40, height: 12 },
      ],
    };
    const pinnedState = { ...state, config: { ...state.config, layout } };
    tickerLinkMenuItems({
      instance: pinned,
      layout,
      panes,
      state: pinnedState,
      persistLayout: (nextLayout) => { layout = nextLayout; },
    }).find((item) => item.id === "link:portfolio-list:main")?.onSelect?.();

    expect(findPaneInstance(layout, target.instanceId)?.binding).toEqual({
      kind: "follow",
      sourceInstanceId: "portfolio-list:main",
    });
    expect(findPaneInstance(layout, previousFollower.instanceId)?.binding).toEqual({
      kind: "fixed",
      symbol: "AAPL",
    });
  });

  // Any pane flagged tickerFollower links like DES, but only DES keeps one follower per source, the
  // header shows the live ticker, and a pane chained to a fixed pane gets no rows or suffix.
  test("a flagged pane follows a list, shows its ticker live, and pins on unlink or a closed source", () => {
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-link-menu-follower-test"));
    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "AAPL" };
    const opx = createPaneInstance("options-positioning", {
      instanceId: "options-positioning:AAPL",
      title: "OPX AAPL",
      binding: { kind: "fixed", symbol: "AAPL" },
    });
    const surface = createPaneInstance("vol-surface", { instanceId: "vol-surface:SPY", binding: { kind: "fixed", symbol: "SPY" } });
    const chain = createPaneInstance("options", {
      instanceId: "options:desk",
      binding: { kind: "follow", sourceInstanceId: surface.instanceId },
    });
    const notes = createPaneInstance("notes", { instanceId: "notes:1", binding: { kind: "fixed", symbol: "AAPL" } });
    // Linked some other way, so its stored title still names the ticker it opened on.
    const legacy = createPaneInstance("options", {
      instanceId: "options:legacy",
      title: "OMON AAPL",
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
    });
    const added = [opx, surface, chain, notes, legacy];
    let layout: LayoutConfig = {
      ...state.config.layout,
      instances: [...state.config.layout.instances, ...added],
      floating: added.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: index, width: 40, height: 12 })),
    };
    const at = (nextLayout: LayoutConfig) => ({ ...state, config: { ...state.config, layout: nextLayout } });
    const menu = (instanceId: string, current = at(layout)) => tickerLinkMenuItems({
      instance: findPaneInstance(layout, instanceId)!,
      layout,
      panes,
      state: current,
      persistLayout: (nextLayout) => { layout = nextLayout; },
    });
    const title = (instanceId: string, current = at(layout)) => {
      const instance = findPaneInstance(current.config.layout, instanceId)!;
      return getPaneDisplayTitle(current, instance, panes.get(instance.paneId)!, panes);
    };

    expect(menu(notes.instanceId)).toEqual([]);
    // vol-surface is not a single-ticker pane here, so the chain can move to a list or another
    // asset pane, and there is no row to unlink from the surface.
    expect(menu(chain.instanceId).map((item) => item.id)).toEqual([
      "link:portfolio-list:main",
      "link:ticker-detail:main",
      "link:options-positioning:AAPL",
      "link:options:legacy",
    ]);
    expect(title(chain.instanceId)).toBe("Options: SPY");

    menu(opx.instanceId).find((item) => item.id === "link:portfolio-list:main")!.onSelect!();
    expect(findPaneInstance(layout, opx.instanceId)).toMatchObject({
      title: "OPX",
      binding: { kind: "follow", sourceInstanceId: "portfolio-list:main" },
    });
    expect(findPaneInstance(layout, "ticker-detail:main")!.binding).toEqual({
      kind: "follow",
      sourceInstanceId: "portfolio-list:main",
    });
    expect(title(opx.instanceId)).toBe("OPX AAPL  ⧉ Linked to Main Portfolio");

    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "MSFT" };
    expect(title(opx.instanceId)).toBe("OPX MSFT  ⧉ Linked to Main Portfolio");

    const linked = layout;
    const unlink = menu(opx.instanceId).find((item) => item.id === "unlink:portfolio-list:main")!;
    expect(unlink.label).toBe("Unlink from Main Portfolio");
    unlink.onSelect!();
    expect(findPaneInstance(layout, opx.instanceId)).toMatchObject({
      title: "OPX MSFT",
      binding: { kind: "fixed", symbol: "MSFT" },
    });

    // Closing the list instead pins the follower the same way.
    const closed = appReducer(at(linked), {
      type: "UPDATE_LAYOUT",
      layout: removePaneInstances(linked, ["portfolio-list:main"]),
    }).config.layout;
    expect(findPaneInstance(closed, opx.instanceId)).toMatchObject({
      title: "OPX MSFT",
      binding: { kind: "fixed", symbol: "MSFT" },
    });
    expect(findPaneInstance(closed, legacy.instanceId)).toMatchObject({
      title: "OMON MSFT",
      binding: { kind: "fixed", symbol: "MSFT" },
    });
  });

  test("single-ticker panes link to each other, refuse a cycle, and pin when the source closes", () => {
    const linkedPanes = new Map(panes);
    linkedPanes.set("vol-surface", {
      ...panes.get("vol-surface")!,
      tickerFollower: true,
    });
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-link-menu-peers"));
    state.paneState["portfolio-list:main"] = { collectionId: "main", cursorSymbol: "AAPL" };
    const surface = createPaneInstance("vol-surface", {
      instanceId: "vol-surface:SPY",
      title: "OVDV SPY",
      binding: { kind: "fixed", symbol: "SPY" },
    });
    const options = createPaneInstance("options", {
      instanceId: "options:AAPL",
      title: "OMON AAPL",
      binding: { kind: "fixed", symbol: "AAPL" },
    });
    const second = createPaneInstance("options", {
      instanceId: "options:second",
      title: "OMON QQQ",
      binding: { kind: "fixed", symbol: "QQQ" },
    });
    const added = [surface, options, second];
    let layout: LayoutConfig = {
      ...state.config.layout,
      instances: [...state.config.layout.instances, ...added],
      floating: added.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: index, width: 40, height: 12 })),
    };
    const at = (nextLayout: LayoutConfig) => ({ ...state, config: { ...state.config, layout: nextLayout } });
    const menu = (instanceId: string, current = at(layout)) => tickerLinkMenuItems({
      instance: findPaneInstance(layout, instanceId)!,
      layout,
      panes: linkedPanes,
      state: current,
      persistLayout: (nextLayout) => { layout = nextLayout; },
    });
    const title = (instanceId: string, current = at(layout)) => {
      const instance = findPaneInstance(current.config.layout, instanceId)!;
      return getPaneDisplayTitle(current, instance, linkedPanes.get(instance.paneId)!, linkedPanes);
    };

    // Ticker Research's title is only its symbol, so a row names the pane as well.
    expect(menu(options.instanceId).find((item) => item.id === "link:ticker-detail:main")?.label)
      .toBe("Link to Ticker Research AAPL");
    menu(options.instanceId).find((item) => item.id === "link:vol-surface:SPY")!.onSelect!();
    menu(second.instanceId).find((item) => item.id === "link:vol-surface:SPY")!.onSelect!();
    expect(findPaneInstance(layout, options.instanceId)).toMatchObject({
      title: "OMON",
      binding: { kind: "follow", sourceInstanceId: surface.instanceId },
    });
    expect(findPaneInstance(layout, second.instanceId)?.binding).toEqual({
      kind: "follow",
      sourceInstanceId: surface.instanceId,
    });
    expect(title(options.instanceId)).toBe("OMON SPY  ⧉ Linked to OVDV");
    expect(menu(surface.instanceId).map((item) => item.id)).not.toContain(`link:${options.instanceId}`);

    const linked = layout;
    menu(options.instanceId).find((item) => item.id === "unlink:vol-surface:SPY")!.onSelect!();
    expect(findPaneInstance(layout, options.instanceId)).toMatchObject({
      title: "OMON SPY",
      binding: { kind: "fixed", symbol: "SPY" },
    });

    const closed = appReducer(at(linked), {
      type: "UPDATE_LAYOUT",
      layout: removePaneInstances(linked, [surface.instanceId]),
    }).config.layout;
    expect(findPaneInstance(closed, second.instanceId)).toMatchObject({
      title: "OMON SPY",
      binding: { kind: "fixed", symbol: "SPY" },
    });
  });
});

// A research pane pinned without the user asking (its list closed, or another research pane took
// the list) once stayed off the list for good, and Enter on a row stacked a new pane each time.
describe("a research pane its link left", () => {
  const research = "ticker-detail:main";
  const portfolio = "portfolio-list:main";
  const setup = (path: string) => {
    const state = createInitialState(createDefaultConfig(path));
    state.paneState[portfolio] = { collectionId: "main", cursorSymbol: "AAPL" };
    return state;
  };
  const withPanes = (layout: LayoutConfig, ...added: ReturnType<typeof createPaneInstance>[]): LayoutConfig => ({
    ...layout,
    instances: [...layout.instances, ...added],
    floating: [...layout.floating, ...added.map((instance, index) => ({ instanceId: instance.instanceId, x: index, y: index, width: 40, height: 12 }))],
  });
  const title = (state: ReturnType<typeof setup>, instanceId = research) => {
    const instance = findPaneInstance(state.config.layout, instanceId)!;
    return getPaneDisplayTitle(state, instance, panes.get(instance.paneId)!, panes);
  };
  const update = (state: ReturnType<typeof setup>, layout: LayoutConfig) => appReducer(state, { type: "UPDATE_LAYOUT", layout });

  test("one displaced by another research pane follows its list again once that pane leaves it", () => {
    let state = setup("/tmp/gloomberb-relink-displaced");
    const second = createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "ticker-detail:second", binding: { kind: "fixed", symbol: "MSFT" } });
    state = update(state, withPanes(state.config.layout, second));
    tickerLinkMenuItems({
      instance: second,
      layout: state.config.layout,
      panes,
      state,
      persistLayout: (layout) => { state = update(state, layout); },
    }).find((item) => item.id === `link:${portfolio}`)!.onSelect!();

    expect(findPaneInstance(state.config.layout, research)).toMatchObject({
      binding: { kind: "fixed", symbol: "AAPL" },
      unlinkedFrom: { instanceId: portfolio, paneId: "portfolio-list", auto: true },
    });
    expect(title(state)).toBe("AAPL  ⧉ Unlinked");
    expect(resolveTickerActivation(state.config.layout, portfolio)).toEqual({ kind: "focus", paneId: second.instanceId });

    // A ticker the user picks for it makes the pin theirs: it stays when the list is free.
    const searched = update(state, removePaneInstances(retargetTickerPane(state.config.layout,
      findPaneInstance(state.config.layout, research)!, "NVDA", { previous: "AAPL" }), [second.instanceId]));
    expect(findPaneInstance(searched.config.layout, research)).toMatchObject({
      binding: { kind: "fixed", symbol: "NVDA" },
      unlinkedFrom: { instanceId: portfolio, paneId: "portfolio-list" },
    });
    expect(findPaneInstance(searched.config.layout, research)?.unlinkedFrom?.auto).toBeUndefined();

    state = update(state, removePaneInstances(state.config.layout, [second.instanceId]));
    expect(findPaneInstance(state.config.layout, research)?.binding).toEqual({ kind: "follow", sourceInstanceId: portfolio });
    expect(findPaneInstance(state.config.layout, research)?.unlinkedFrom).toBeUndefined();
    expect(title(state)).toBe("AAPL  ⧉ Linked to Main Portfolio");
  });

  test("one whose list closed follows that kind of list opened again, not one already there", () => {
    let state = setup("/tmp/gloomberb-relink-closed");
    const watchlist = createPaneInstance("portfolio-list", { instanceId: "portfolio-list:watch", params: { collectionId: "watchlist" } });
    state = update(state, withPanes(state.config.layout, watchlist));
    state = update(state, removePaneInstances(state.config.layout, [portfolio]));

    expect(findPaneInstance(state.config.layout, research)).toMatchObject({
      binding: { kind: "fixed", symbol: "AAPL" },
      unlinkedFrom: { instanceId: portfolio, paneId: "portfolio-list", auto: true },
    });
    expect(title(state)).toBe("AAPL  ⧉ Unlinked");
    // A restart keeps how it was pinned.
    expect(findPaneInstance(sanitizeLayout(JSON.parse(JSON.stringify(state.config.layout)), state.config.layout), research)?.unlinkedFrom)
      .toEqual({ instanceId: portfolio, paneId: "portfolio-list", auto: true });
    // Enter on the list that was there shows the row in it rather than stacking another pane.
    expect(resolveTickerActivation(state.config.layout, watchlist.instanceId)).toEqual({ kind: "open", reusePaneId: research });
    expect(resolveTickerActivation(state.config.layout, watchlist.instanceId, { newPane: true })).toEqual({ kind: "open" });

    const reopened = createPaneInstance("portfolio-list", { instanceId: "portfolio-list:reopened", params: { collectionId: "main" } });
    state = update(state, withPanes(state.config.layout, reopened));
    expect(findPaneInstance(state.config.layout, research)?.binding).toEqual({ kind: "follow", sourceInstanceId: reopened.instanceId });
    expect(resolveTickerActivation(state.config.layout, reopened.instanceId)).toEqual({ kind: "focus", paneId: research });
  });

  test("one the user unlinked stays pinned, and Enter reuses it while it is the only one", () => {
    let state = setup("/tmp/gloomberb-relink-user");
    const menu = () => tickerLinkMenuItems({
      instance: findPaneInstance(state.config.layout, research)!,
      layout: state.config.layout,
      panes,
      state,
      persistLayout: (layout) => { state = update(state, layout); },
    });
    menu().find((item) => item.id === `unlink:${portfolio}`)!.onSelect!();
    expect(findPaneInstance(state.config.layout, research)).toMatchObject({
      binding: { kind: "fixed", symbol: "AAPL" },
      unlinkedFrom: { instanceId: portfolio, paneId: "portfolio-list" },
    });
    expect(title(state)).toBe("AAPL  ⧉ Unlinked");

    const reopened = createPaneInstance("portfolio-list", { instanceId: "portfolio-list:other", params: { collectionId: "main" } });
    state = update(state, withPanes(state.config.layout, reopened));
    expect(findPaneInstance(state.config.layout, research)?.binding).toEqual({ kind: "fixed", symbol: "AAPL" });
    expect(resolveTickerActivation(state.config.layout, portfolio)).toEqual({ kind: "open", reusePaneId: research });

    // With two pinned and neither cut by the app, there is no telling which one Enter means.
    const typed = createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "ticker-detail:typed", binding: { kind: "fixed", symbol: "MSFT" } });
    expect(resolveTickerActivation(withPanes(state.config.layout, typed), portfolio)).toEqual({ kind: "open" });

    menu().find((item) => item.id === `link:${portfolio}`)!.onSelect!();
    expect(findPaneInstance(state.config.layout, research)?.unlinkedFrom).toBeUndefined();
    expect(title(state)).toBe("AAPL  ⧉ Linked to Main Portfolio");
  });
});

// One code per listing: a template titled FA 9992:XHKG while the CLI, search and the chart named 9992:HKEX.
test("a pane title names each ticker key its template wrote by the venue's code, and leaves any other title as written", () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-title-test"));
  const notes = panes.get("notes")!;
  const titled = (title: string) => getPaneDisplayTitle(state,
    createPaneInstance("notes", { instanceId: "notes:x", title, binding: { kind: "fixed", symbol: "9992:XHKG" } }), notes, panes);
  expect(titled("FA 9992:XHKG")).toBe("FA 9992:HKEX");
  expect(titled("RV 9992:XHKG,PLTR")).toBe("RV 9992:HKEX,PLTR");
  expect(titled("RIPL AAPL, 9992:XHKG")).toBe("RIPL AAPL, 9992:HKEX");
  expect(titled("FA AAPL")).toBe("FA AAPL");
  expect(titled("Pop Mart 9992:XHKG notes")).toBe("Pop Mart 9992:XHKG notes");
  // A Quote Monitor window, saved under its listings' stored keys, reads as its cards do (QQ read "0700:XHKG · XYZ:XNYS").
  expect(titled("0700:XHKG · XYZ:XNYS")).toBe("0700:HKEX · XYZ:NYSE");
  expect(titled("0700:XHKG · XYZ:XNYS +2")).toBe("0700:HKEX · XYZ:NYSE +2");
  expect(titled(buildQuoteMonitorPaneTitle(["0700:XHKG", "XYZ:XNYS", "AAPL"]))).toBe("0700:HKEX · XYZ:NYSE · AAPL");
});

test("a coin's pane title names its pair alone, never the crypto venue's code", () => {
  const initial = createInitialState(createDefaultConfig("/tmp/gloomberb-title-test"));
  const research = createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "ticker-detail:usdt", binding: { kind: "fixed", symbol: "USDT-USD:CCC" } });
  const notes = createPaneInstance("notes", { instanceId: "notes:usdt", binding: { kind: "fixed", symbol: "USDT-USD:CCC" } });
  const aapl = createPaneInstance(TICKER_RESEARCH_PANE_ID, { instanceId: "ticker-detail:aapl", binding: { kind: "fixed", symbol: "AAPL:NASDAQ" } });
  const layout = { ...initial.config.layout, instances: [...initial.config.layout.instances, research, notes, aapl] };
  const state = { ...initial, config: { ...initial.config, layout } };
  expect(getPaneDisplayTitle(state, research, panes.get(TICKER_RESEARCH_PANE_ID)!, panes)).toBe("USDT-USD");
  expect(getPaneDisplayTitle(state, notes, panes.get("notes")!, panes)).toBe("Notes: USDT-USD");
  // A stock keeps its venue.
  expect(getPaneDisplayTitle(state, aapl, panes.get(TICKER_RESEARCH_PANE_ID)!, panes)).toBe("AAPL:NASDAQ");
});
