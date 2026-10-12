import { describe, expect, test } from "bun:test";
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
    expect(findReusablePaneInstance([first, second], hm, templatesOf(hm), {}, "hm:2")?.instanceId).toBe("hm:2");
    expect(findReusablePaneInstance([first, second], hm, templatesOf(hm), {}, null)?.instanceId).toBe("hm:1");
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
  // One pane type behind two functions that both ask for nothing: which settings
  // belong to which function is not something the host can tell.
  "mna-pane": "shares a pane type with DIST",
  "distress-pane": "shares a pane type with MA",
  "earnings-calendar-pane": "shares a pane type with EVTS",
  "power-pane": "shares a pane type with EPWR",
  "sectors-pane": "shares a pane type with THEM",
  "themes-pane": "shares a pane type with BI",
};

describe("every function opens once", () => {
  test("opening it again focuses its window, even after the pane picked up a setting of its own", async () => {
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
          const state = createInitialState({ ...config, layout: { dockRoot: null, instances: [], floating: [], detached: [] } });
          for (const symbol of ["AAPL", "MSFT"]) {
            state.tickers.set(symbol, createTestTicker(symbol, symbol, { exchange: "NASDAQ", currency: "USD" }));
          }
          let added = 0;
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
              focusPane: () => {},
              updateLayout: (layout: typeof state.config.layout) => { state.config.layout = layout; },
            } as never,
            buildPaneInstance: (paneType: string, spec?: Partial<PaneInstanceConfig>) => createPaneInstance(paneType, spec ?? {}),
            placePaneInstance: (placed: PaneInstanceConfig) => {
              added += 1;
              state.config.layout = {
                ...state.config.layout,
                instances: [...state.config.layout.instances, placed],
                floating: [...state.config.layout.floating, { instanceId: placed.instanceId, x: 0, y: 0, width: 60, height: 20, zIndex: 50 }],
              };
            },
          };
          try {
            await createPaneTemplateOrThrow(id, options, deps);
          } catch {
            continue; // Nothing to open without a ticker or a context.
          }
          if (added === 0) continue;
          // The pane writes a view preference into its own settings, as a quick-setting toggle does.
          state.config.layout = {
            ...state.config.layout,
            instances: state.config.layout.instances.map((placed) => ({
              ...placed,
              settings: { ...(placed.settings ?? {}), liveStreaming: false },
            })),
          };
          await createPaneTemplateOrThrow(id, options, deps);
          if (added === 1) reused += 1;
          else dupes.push(id);
        }
      }
    } finally {
      catalog.destroy();
    }

    expect([...new Set(dupes)].sort()).toEqual(Object.keys(OPENS_ANOTHER_WINDOW).sort());
    expect(reused).toBeGreaterThan(100);
  });
});
