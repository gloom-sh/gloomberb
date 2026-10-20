import { describe, expect, test } from "bun:test";
import { setCloudApiFetchTransport } from "../../../api-client";
import { resetGeoCatalogCache } from "../../../api-client/geo";
import { createPaneCatalog } from "../../../cli/pane-functions/discovery";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import { getLoadablePlugins } from "../../../plugins/catalog";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig, createPaneInstance, type PaneInstanceConfig } from "../../../types/config";
import type { PaneTemplateCreateOptions, PaneTemplateDef, PaneTemplateInstanceConfig } from "../../../types/plugin";
import { findReusablePaneInstance } from "./pane-reuse";
import { createPaneTemplateOrThrow } from "./ops";

function template(id: string, paneId: string, shortcut?: PaneTemplateDef["shortcut"]): PaneTemplateDef {
  return { id, paneId, label: id, description: id, shortcut };
}

const instance = (instanceId: string, paneId: string, fields: Partial<PaneInstanceConfig> = {}): PaneInstanceConfig => ({
  instanceId,
  paneId,
  ...fields,
});

const templatesOf = (...entries: PaneTemplateDef[]) => new Map(entries.map((entry) => [entry.id, entry]));
const fixed = (symbol: string) => ({ kind: "fixed" as const, symbol });

describe("which open pane a template focuses", () => {
  // A pane gains settings the moment the user touches one (the live streaming
  // toggle, a range, a column); the spec it was opened with has none of them.
  test("a pane that has since gained settings is still the one the spec describes", () => {
    const qq = template("qq", "quote-monitor", { prefix: "QQ", argPlaceholder: "tickers" });
    const spec: PaneTemplateInstanceConfig = { settings: { symbols: ["AAPL", "MSFT"] } };
    const open = instance("quote:1", "quote-monitor", { settings: { symbols: ["AAPL", "MSFT"], liveStreaming: false } });
    const other = instance("quote:2", "quote-monitor", { settings: { symbols: ["NVDA"], liveStreaming: false } });

    expect(findReusablePaneInstance([other, open], qq, templatesOf(qq), spec)?.instanceId).toBe("quote:1");
    expect(findReusablePaneInstance([other], qq, templatesOf(qq), spec)).toBeNull();
  });

  test("a stable id that was opened on another ticker does not hide a pane that shows this one", () => {
    const fa = template("fa", "financial-analysis", { prefix: "FA", argPlaceholder: "ticker" });
    const spec: PaneTemplateInstanceConfig = { instanceId: "financial-analysis:MSFT", binding: fixed("MSFT") };
    // Opened as FA AAPL, unlinked from its list since, now on MSFT, with a setting of its own.
    const drifted = instance("financial-analysis:AAPL", "financial-analysis", { binding: fixed("MSFT"), settings: { period: "q" } });
    const linked = instance("financial-analysis:main", "financial-analysis", { binding: { kind: "follow", sourceInstanceId: "list" } });

    expect(findReusablePaneInstance([linked, drifted], fa, templatesOf(fa), spec)?.instanceId).toBe("financial-analysis:AAPL");
    // A pane following a list shows whatever the list shows: it is not taken over.
    expect(findReusablePaneInstance([linked], fa, templatesOf(fa), spec)).toBeNull();
    expect(findReusablePaneInstance([drifted], fa, templatesOf(fa), { ...spec, binding: fixed("NVDA") })).toBeNull();
  });

  test("a function that takes no argument is one window whatever its settings", () => {
    const hm = template("hm", "market-heatmap", { prefix: "HM" });
    const open = instance("market-heatmap:abc", "market-heatmap", { settings: { liveStreaming: false } });
    expect(findReusablePaneInstance([open], hm, templatesOf(hm), {})?.instanceId).toBe("market-heatmap:abc");
  });

  test("a bare form whose argument is optional is the board, and takes the open one", () => {
    const awards = template("awards", "awards", { prefix: "AWARDS", argPlaceholder: "ticker", argOptional: true });
    const open = instance("awards:abc", "awards", { settings: { tab: "board" } });
    expect(findReusablePaneInstance([open], awards, templatesOf(awards), {})?.instanceId).toBe("awards:abc");
  });

  test("a blank form that builds something new stays a new window", () => {
    const view = template("view", "custom-view", { prefix: "VIEW", argPlaceholder: "spec JSON or empty" });
    const built = instance("custom-view:abc", "custom-view", { settings: { spec: "columns" } });
    expect(findReusablePaneInstance([built], view, templatesOf(view), {})).toBeNull();
  });

  // ERN and EVTS open one pane type: EVTS names `board`, ERN asks for nothing.
  test("a bare spec does not take the pane of another function on the same pane type", () => {
    const ern = template("ern", "earnings-calendar", { prefix: "ERN" });
    const evts = template("evts", "earnings-calendar", { prefix: "EVTS" });
    const board = instance("earnings:board", "earnings-calendar", { settings: { board: true } });
    const templates = templatesOf(ern, evts);

    expect(findReusablePaneInstance([board], ern, templates, {})).toBeNull();
    expect(findReusablePaneInstance([board], evts, templates, { settings: { board: true } })?.instanceId).toBe("earnings:board");
  });

  // A pane type that says which settings name a window can tell its functions apart
  // from the windows themselves, including panes saved before the declaration existed.
  test("a pane type that declares its identity settings finds a window that picked up others", () => {
    const ern = template("ern", "earnings-calendar", { prefix: "ERN", argPlaceholder: "tickers", argOptional: true });
    const evts = template("evts", "earnings-calendar", { prefix: "EVTS", argPlaceholder: "ticker", argOptional: true });
    const templates = templatesOf(ern, evts);
    const paneDef = { identitySettings: ["board", "symbols", "symbolsText"] };
    const market = instance("earnings:1", "earnings-calendar", { settings: { liveStreaming: false } });
    const board = instance("earnings:2", "earnings-calendar", { settings: { board: true, liveStreaming: false } });
    const scoped = instance("earnings:3", "earnings-calendar", { settings: { symbols: ["AAPL"], symbolsText: "AAPL", liveStreaming: false } });
    const all = [board, scoped, market];

    expect(findReusablePaneInstance(all, ern, templates, {}, { paneDef })).toBe(market);
    // The other function's windows are never taken, with or without the pane they would take instead.
    expect(findReusablePaneInstance([board, scoped], ern, templates, {}, { paneDef })).toBeNull();
    expect(findReusablePaneInstance(all, evts, templates, { settings: { board: true } }, { paneDef })).toBe(board);
    expect(findReusablePaneInstance([market, scoped], evts, templates, { settings: { board: true } }, { paneDef })).toBeNull();
    // Opened with the tickers named, ERN is the scoped window, not the market one.
    const named = { settings: { symbols: ["AAPL"], symbolsText: "AAPL" } };
    expect(findReusablePaneInstance(all, ern, templates, named, { paneDef })).toBe(scoped);
  });

  test("a spec without settings does not take a pane its sibling function opened with one", () => {
    const opx = template("opx", "options-positioning", { prefix: "OPX", argPlaceholder: "ticker" });
    const gex = template("gex", "options-positioning", { prefix: "GEX", argPlaceholder: "ticker" });
    const gexPane = instance("options-positioning:AAPL:GEX", "options-positioning", { binding: fixed("AAPL"), settings: { tab: "gex" } });

    expect(findReusablePaneInstance([gexPane], opx, templatesOf(opx, gex), { binding: fixed("AAPL") })).toBeNull();
    expect(findReusablePaneInstance([gexPane], gex, templatesOf(opx, gex), { binding: fixed("AAPL"), settings: { tab: "gex" } }))
      .toBe(gexPane);
  });

  test("params stay exact, so each list pane is its own window", () => {
    const pf = template("pf", "portfolio-list", { prefix: "PF" });
    const list = instance("list:1", "portfolio-list", { params: { collectionId: "retirement" } });
    expect(findReusablePaneInstance([list], pf, templatesOf(pf), {})).toBeNull();
    expect(findReusablePaneInstance([list], pf, templatesOf(pf), { params: { collectionId: "retirement" } })).toBe(list);
  });

  test("of several panes that match, the focused one wins", () => {
    const hm = template("hm", "market-heatmap", { prefix: "HM" });
    const first = instance("hm:1", "market-heatmap", { settings: { a: 1 } });
    const second = instance("hm:2", "market-heatmap", { settings: { a: 2 } });
    expect(findReusablePaneInstance([first, second], hm, templatesOf(hm), {}, { focusedPaneId: "hm:2" })?.instanceId).toBe("hm:2");
    expect(findReusablePaneInstance([first, second], hm, templatesOf(hm), {}, { focusedPaneId: null })?.instanceId).toBe("hm:1");
  });
});

/**
 * Every function in the catalog, opened a second time from the command bar
 * after its pane picked up a setting of its own. These are the ones that
 * still open a second window, each on purpose:
 */
const OPENS_ANOTHER_WINDOW: Record<string, string> = {
  // A blank form builds a new view each time.
  "custom-view-pane": "blank VIEW builds a new view",
  // They create a new list, not open one.
  "new-collection-pane": "creates a list",
  "new-portfolio-pane": "creates a list",
  "new-watchlist-pane": "creates a list",
};

/** The host's side of opening a function: what it adds and what it focuses, over a layout it starts from. */
async function openFunctions(
  catalog: Awaited<ReturnType<typeof createPaneCatalog>>,
  placed: PaneInstanceConfig[],
) {
  const config = createDefaultConfig("/tmp/gloomberb-pane-reuse-catalog");
  const state = createInitialState({
    ...config,
    layout: {
      dockRoot: null,
      instances: placed,
      floating: placed.map((entry) => ({ instanceId: entry.instanceId, x: 0, y: 0, width: 60, height: 20, zIndex: 50 })),
      detached: [],
    },
  });
  for (const symbol of ["AAPL", "MSFT"]) {
    state.tickers.set(symbol, createTestTicker(symbol, symbol, { exchange: "NASDAQ", currency: "USD" }));
  }
  const added: string[] = [];
  const focused: string[] = [];
  const deps = {
    dataProvider: createTestDataProvider({ id: "test" }),
    tickerRepository: new JsonTickerRepository(),
    dispatch: () => {},
    getState: () => state,
    pluginRegistry: {
      paneTemplates: catalog.paneTemplates,
      panes: catalog.panes,
      getPaneTemplatePluginId: () => undefined,
      getDisabledPaneTemplateOwner: () => null,
      events: { emit: () => {} },
      focusPane: (paneId: string) => { focused.push(paneId); },
      updateLayout: (layout: typeof state.config.layout) => { state.config.layout = layout; },
    } as never,
    buildPaneInstance: (paneType: string, spec?: Partial<PaneInstanceConfig>) => createPaneInstance(paneType, spec ?? {}),
    placePaneInstance: (placedInstance: PaneInstanceConfig) => {
      added.push(placedInstance.instanceId);
      state.config.layout = {
        ...state.config.layout,
        instances: [...state.config.layout.instances, placedInstance],
        floating: [...state.config.layout.floating, { instanceId: placedInstance.instanceId, x: 0, y: 0, width: 60, height: 20, zIndex: 50 }],
      };
    },
  };
  return {
    open: (id: string, options?: PaneTemplateCreateOptions) => createPaneTemplateOrThrow(id, options, deps),
    layout: () => state.config.layout,
    added,
    focused,
    /** The pane picks up a view preference of its own, as a toggled quick setting does. */
    tune: () => {
      state.config.layout = {
        ...state.config.layout,
        instances: state.config.layout.instances.map((entry) => ({ ...entry, settings: { ...(entry.settings ?? {}), liveStreaming: false } })),
      };
    },
  };
}

describe("every function opens once", () => {
  test("opening it again focuses its window, even after the pane picked up a setting of its own", async () => {
    // CHOKE reads the geo catalog while opening: answer the Cloud API here, and leave nothing cached for the next file.
    setCloudApiFetchTransport(async () => Response.json({ error: "NOT_FOUND", message: "Not found" }, { status: 404 }));
    const config = createDefaultConfig("/tmp/gloomberb-pane-reuse-catalog");
    const catalog = await createPaneCatalog({ config } as never, getLoadablePlugins());
    const dupes: string[] = [];
    let reused = 0;
    try {
      for (const [id, entry] of [...catalog.paneTemplates].sort(([left], [right]) => left.localeCompare(right))) {
        if (id === "new-chat-pane") continue; // Chat picks its own pane: open-conversation.test.ts
        const argKind = entry.shortcut?.argPlaceholder ?? "";
        const variants: Array<PaneTemplateCreateOptions | undefined> = [undefined];
        if (entry.shortcut?.argKind === "ticker" || argKind === "ticker") variants.push({ arg: "AAPL" });
        else if (entry.shortcut?.argKind === "ticker-list" || argKind === "tickers") variants.push({ arg: "AAPL MSFT" });
        for (const options of variants) {
          const host = await openFunctions(catalog, []);
          try {
            await host.open(id, options);
          } catch {
            continue; // Nothing to open without a ticker or a context.
          }
          if (host.added.length === 0) continue;
          host.tune();
          await host.open(id, options);
          if (host.added.length === 1) reused += 1;
          else dupes.push(id);
        }
      }
    } finally {
      catalog.destroy();
      setCloudApiFetchTransport(null);
      resetGeoCatalogCache();
    }

    expect([...new Set(dupes)].sort()).toEqual(Object.keys(OPENS_ANOTHER_WINDOW).sort());
    expect(reused).toBeGreaterThan(100);
  });

  // Two functions on one pane type. Layouts saved before the pane type said which
  // settings name a window hold panes with no marker, tuned or not: each is still
  // found by its own function, and never taken by the other.
  const PAIRS: Array<{ pair: string; first: string; second: string; paneId: string; legacy: Record<string, Partial<PaneInstanceConfig>> }> = [
    {
      pair: "ERN and EVTS", first: "earnings-calendar-pane", second: "earnings-board-pane", paneId: "earnings-calendar",
      legacy: { "earnings-calendar-pane": {}, "earnings-board-pane": { settings: { board: true } } },
    },
    {
      pair: "MA and DIST", first: "mna-pane", second: "distress-pane", paneId: "mna",
      legacy: { "mna-pane": {}, "distress-pane": { params: { tab: "distress" } } },
    },
    {
      pair: "POWER and EPWR", first: "power-pane", second: "power-prices-pane", paneId: "power",
      legacy: { "power-pane": { params: { symbol: "" } }, "power-prices-pane": { settings: { tab: "prices" } } },
    },
    {
      pair: "BI and THEM", first: "sectors-pane", second: "themes-pane", paneId: "sectors",
      legacy: { "sectors-pane": {}, "themes-pane": { params: { theme: "" } } },
    },
  ];

  for (const { pair, first, second, paneId, legacy } of PAIRS) {
    test(`${pair}: each finds its own window, tuned or not, and never the other's`, async () => {
      const catalog = await createPaneCatalog({ config: createDefaultConfig("/tmp/gloomberb-pane-reuse-catalog") } as never, getLoadablePlugins());
      try {
        const legacyPane = (id: string, settings: Record<string, unknown> = {}) => {
          const stored = legacy[id]!;
          return createPaneInstance(paneId, {
            instanceId: `${paneId}:${id}`,
            params: stored.params,
            settings: { ...(stored.settings ?? {}), ...settings },
          });
        };
        for (const tuned of [{}, { liveStreaming: false }]) {
          const both = await openFunctions(catalog, [legacyPane(first, tuned), legacyPane(second, tuned)]);
          await both.open(first);
          await both.open(second);
          expect(both.added).toEqual([]);
          expect(both.focused).toEqual([`${paneId}:${first}`, `${paneId}:${second}`]);

          // With only the other function's window open, a window of its own is added.
          for (const [mine, theirs] of [[first, second], [second, first]] as const) {
            const alone = await openFunctions(catalog, [legacyPane(theirs, tuned)]);
            await alone.open(mine);
            expect(alone.focused).toEqual([]);
            expect(alone.added).toHaveLength(1);
          }
        }
        // The window a function opens itself is found again after it picked up a setting.
        for (const id of [first, second]) {
          const host = await openFunctions(catalog, []);
          await host.open(id);
          host.tune();
          await host.open(id);
          expect(host.added).toHaveLength(1);
        }
      } finally {
        catalog.destroy();
      }
    });
  }
});
