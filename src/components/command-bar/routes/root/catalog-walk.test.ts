import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildPaneCatalogEntries, type PaneCatalogEntry, type PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import { createPaneCatalog } from "../../../../cli/pane-functions/discovery";
import type { MarketContext } from "../../../../cli/types";
import { getLoadablePlugins } from "../../../../plugins/catalog";
import { RegistryContributions } from "../../../../plugins/registry/contributions";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createDefaultConfig, type AppConfig } from "../../../../types/config";
import type { CommandDef } from "../../../../types/plugin";
import type { AssistRowHandlers } from "../../assist/model";
import { commands } from "../../commands/registry";
import { resolveRowBadge } from "../../list/badge";
import type { ResultItem } from "../../list/model";
import {
  buildPaneTemplateContext,
  buildPaneTemplateItem,
  getAvailablePaneShortcutTemplatesForQuery,
  paneTemplateArgError,
} from "../../pane-templates/items";
import { buildRootResultModel, type RootResultModelOptions } from "./results";
import { leadingShortcutCode, parseRootShortcutIntent } from "./shortcuts";

/**
 * `gloom catalog` lists what each function takes after its code. Typed in the
 * command bar with such an argument, the function must be what answers: a
 * function the bar's parser cannot read (PF <portfolio-or-watchlist> did not
 * once) falls through to the free-text search, which signed out leaves only
 * the Ask AI sign-up offer, and Enter on it opens Sign Up.
 */

/** A list of one is typed too: `CMP AAPL` is still CMP, though it compares two or more. */
const SAMPLES_BY_KIND: Record<string, readonly string[]> = {
  ticker: ["AAPL"],
  tickers: ["AAPL,MSFT", "AAPL"],
  "ticker-list": ["AAPL,MSFT", "AAPL"],
  "symbol-list": ["AAPL,MSFT", "AAPL"],
};

interface CollectionArgument {
  /**
   * Arguments that name a portfolio or watchlist there is, or none at all
   * (EXPO's tickers), with the params the pane opens with: the one named, by
   * its id, never the first portfolio.
   */
  known: Record<string, Record<string, unknown>>;
  /** Arguments naming one nothing has, with the row the bar shows for each. */
  unknown: ReadonlyArray<{ arg: string; message: string; detail: string }>;
}

/**
 * Every function whose argument is a portfolio or watchlist, by name or id in
 * any case. The walk finds them in the catalog from what their argument says
 * it takes, so a new one fails until it is listed here, with its own row.
 */
const COLLECTION_ARGUMENTS: Record<string, CollectionArgument> = {
  PF: {
    known: { Book: { collectionId: "book" }, MAIN: { collectionId: "main" }, Watchlist: { collectionId: "watchlist" } },
    unknown: [{ arg: "Nope", message: 'No portfolio or watchlist named "Nope"', detail: "Try Main Portfolio, Book or Watchlist" }],
  },
  PORT: {
    known: { Book: { portfolioId: "book" }, main: { portfolioId: "main" } },
    unknown: [{ arg: "Watchlist", message: 'No portfolio named "Watchlist"', detail: "Try Main Portfolio or Book" }],
  },
  MARS: {
    known: { book: { portfolioId: "book" } },
    unknown: [{ arg: "Nope", message: 'No portfolio named "Nope"', detail: "Try Main Portfolio or Book" }],
  },
  EXPO: {
    known: {
      "PORT:Book": { input: "PORT:book" },
      "port:main portfolio": { input: "PORT:main" },
      "WATCH:WATCHLIST": { input: "WATCH:watchlist" },
      "AAPL=60% NVDA=40%": { input: "AAPL=60% NVDA=40%" },
    },
    unknown: [
      { arg: "PORT:Nope", message: 'No portfolio named "Nope"', detail: "Try PORT:Main Portfolio or PORT:Book" },
      { arg: "WATCH:Book", message: 'No watchlist named "Book"', detail: "Try WATCH:Watchlist" },
    ],
  },
};

const config: AppConfig = (() => {
  const base = createDefaultConfig("/tmp/gloomberb-catalog-walk");
  return { ...base, portfolios: [...base.portfolios, { id: "book", name: "Book", currency: "USD" }] };
})();

const signedOut: AssistRowHandlers = {
  enabled: false,
  auto: false,
  state: { status: "idle" },
  onAsk: () => {},
  onSignUp: () => {},
  onRunCandidate: () => {},
};

let catalog: PaneFunctionCatalog;
let entries: PaneCatalogEntry[];
const contributions = new RegistryContributions({ wrapComponent: (_pluginId, component) => component });
const pluginCommands: CommandDef[] = getLoadablePlugins().flatMap((plugin) => plugin.commands ?? []);

beforeAll(async () => {
  const market = {
    config,
    store: { loadTicker: async () => null, loadAllTickers: async () => [] },
    dataProvider: createTestDataProvider(),
  } as unknown as MarketContext;
  catalog = await createPaneCatalog(market, getLoadablePlugins());
  entries = await buildPaneCatalogEntries(catalog, market);
  // Registered the way the app registers them, so the bar reads each template as the app does.
  for (const pane of catalog.panes.values()) contributions.registerPane("catalog", pane);
  for (const template of catalog.paneTemplates.values()) contributions.registerPaneTemplate("catalog", template);
});
afterAll(() => catalog.destroy());

const context = buildPaneTemplateContext({ config, focusedPaneId: null, activeTicker: null, activeCollectionId: null });

function readQuery(query: string) {
  const paneTemplates = getAvailablePaneShortcutTemplatesForQuery({
    pluginRegistry: {
      paneTemplates: contributions.paneTemplatesMap,
      getPaneTemplatePluginId: (id: string) => contributions.paneTemplatesMap.owners.get(id),
    } as never,
    disabledPlugins: [],
    context,
    query,
  });
  return {
    intent: parseRootShortcutIntent({ query, commands, pluginCommands, paneTemplates, activeTicker: null }),
    leadingCode: leadingShortcutCode({ query, commands, pluginCommands, paneTemplates: [...contributions.paneTemplatesMap.values()] }),
  };
}

function rootRows(query: string): ResultItem[] {
  const { intent, leadingCode } = readQuery(query);
  const row = (id: string): ResultItem => ({ id, label: id, detail: "", category: "Panes", kind: "action", action: () => {} });
  const empty = () => [] as ResultItem[];
  const options: RootResultModelOptions = {
    activeCollectionId: null,
    activeTickerData: null,
    activeTickerSymbol: null,
    assist: signedOut,
    availableCommands: commands,
    bindKey: () => {},
    buildLayoutItems: empty,
    buildPaneSettingItems: empty,
    buildWindowModeItems: empty,
    // The bar's own row for a function, as the surface builds it.
    createPaneTemplateItem: (template, itemOptions) => buildPaneTemplateItem({
      ...itemOptions,
      template,
      argError: paneTemplateArgError(template, itemOptions?.createOptions?.arg, context),
      pluginRegistry: { getPaneTemplatePluginId: () => undefined, allPlugins: new Map() } as never,
      runPaneTemplateShortcut: () => {},
      shouldOpenTemplateConfig: () => false,
      openPaneTemplateWorkflow: () => {},
      openPaneTemplateDirect: () => {},
    }),
    createPluginCommandItem: (command) => row(`plugin-command:${command.id}`),
    currentRoute: null,
    executeCollectionCommand: () => {},
    getAvailablePaneShortcutTemplates: () => intent.kind !== "none" && intent.source === "pane-template" ? [intent.template] : [],
    hasPaneSettings: () => false,
    leadingShortcutCode: leadingCode,
    localTickerSearchResultItems: empty,
    nonShortcutPaneTemplateItems: empty,
    openModeRoute: () => {},
    paneShortcutItems: empty,
    pluginCommandItems: empty,
    pluginCommandResultItems: empty,
    rootQuery: query,
    rootShortcutIntent: intent,
    runDirectCommand: () => {},
    runSecurityDescriptionShortcut: () => {},
    state: { config, focusedPaneId: null, tickers: new Map() } as unknown as RootResultModelOptions["state"],
    tickerActionItems: empty,
  };
  return buildRootResultModel(options).items;
}

describe("the catalog's functions in the command bar", () => {
  test("every function typed with an argument it takes is that function, never left to Ask AI", () => {
    // A function with no code (a story or feed pane other panes open) is never typed in the bar.
    const withArgument = entries.filter((entry) => entry.shortcut && entry.argKind && entry.argKind !== "none");
    expect(withArgument.length).toBeGreaterThan(100);
    const misread: string[] = [];
    for (const entry of withArgument) {
      const samples = [...entry.argExamples ?? [], ...SAMPLES_BY_KIND[entry.argKind!] ?? ["Book"]];
      for (const sample of samples) {
        const query = `${entry.token} ${sample}`;
        const { intent } = readQuery(query);
        // A built-in command of the same code answers for its pane (T is DES's ticker research).
        const claimed = intent.kind !== "none"
          && (intent.source !== "pane-template" || intent.template.id === entry.templateId);
        // Signed out, the only Ask AI row is the sign-up offer, which a function's own rows never sit under.
        const offersSignUp = rootRows(query).some((item) => item.id.startsWith("assist:"));
        if (!claimed || offersSignUp) {
          misread.push(`${query} (${intent.kind === "none" ? "not a command" : `read as ${intent.prefix}`})`);
        }
      }
    }
    expect(misread).toEqual([]);
  });

  test("a function that takes a portfolio or watchlist opens one there is, and names them for one nothing has", async () => {
    const takesCollection = entries.filter((entry) => {
      const template = entry.templateId ? catalog.paneTemplates.get(entry.templateId) : undefined;
      const argument = (template?.headless ?? catalog.panes.get(entry.paneId)?.headless)?.argument;
      return entry.shortcut && argument?.kind === "free-text"
        && /\b(portfolio|watchlist)s?\b/i.test(`${argument.placeholder ?? ""} ${argument.description ?? ""}`);
    }).map((entry) => entry.token).sort();
    expect(takesCollection).toEqual(Object.keys(COLLECTION_ARGUMENTS).sort());

    for (const [code, { known, unknown }] of Object.entries(COLLECTION_ARGUMENTS)) {
      for (const [arg, params] of Object.entries(known)) {
        const query = `${code} ${arg}`;
        const { intent } = readQuery(query);
        if (intent.kind === "none" || intent.source !== "pane-template") throw new Error(`${query} is not ${code}`);
        expect({ query, opens: rootRows(query)[0]?.disabled !== true }).toEqual({ query, opens: true });
        const instance = await intent.template.createInstance?.(context, { arg: intent.argText });
        expect({ query, params: instance?.params }).toMatchObject({ query, params });
      }
      const runnable = rootRows(`${code} ${Object.keys(known)[0]}`)[0]!;
      for (const { arg, message, detail } of unknown) {
        const rows = rootRows(`${code} ${arg}`);
        const [errorRow] = rows;
        expect({ label: errorRow?.label, lines: errorRow?.lines, disabled: errorRow?.disabled }).toEqual({
          label: message,
          lines: [{ segments: [{ text: detail }] }],
          disabled: true,
        });
        // The function's own row, saying why: its code sits where the row that opens it has it.
        expect(resolveRowBadge(errorRow!)).toEqual(resolveRowBadge(runnable));
        expect(resolveRowBadge(errorRow!)?.text).toBe(code);
        // Nothing else answers: no sign-up offer, and no key to bind to text that opens nothing.
        expect(rows.map((item) => item.id)).toEqual([errorRow!.id]);
      }
    }
  });

  test("words after a code that takes none never leave the sign-up offer to take Enter", () => {
    const { intent, leadingCode } = readQuery("MOST foo");
    expect(intent.kind).toBe("none");
    expect(leadingCode).toBe("MOST");
    expect(rootRows("MOST foo").some((item) => item.id.startsWith("assist:"))).toBe(false);
    // A question is still offered the assistant, and so is text no code leads.
    expect(rootRows("MOST traded stocks today?").map((item) => item.id)).toContain("assist:sign-up");
    expect(rootRows("show me the newest filings").map((item) => item.id)).toContain("assist:sign-up");
  });
});
