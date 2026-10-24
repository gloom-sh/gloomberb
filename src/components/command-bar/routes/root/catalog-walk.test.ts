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
import type { ResultItem } from "../../list/model";
import {
  buildPaneTemplateContext,
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
    buildLayoutItems: empty,
    buildPaneSettingItems: empty,
    buildWindowModeItems: empty,
    createPaneTemplateItem: (template) => row(`pane-template:${template.id}`),
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

  test("PF takes a portfolio or watchlist by name or id in any case, and names them for one it does not know", () => {
    const argError = (query: string) => {
      const { intent } = readQuery(query);
      if (intent.kind === "none" || intent.source !== "pane-template") return "not PF";
      expect(intent.template.id).toBe("new-collection-pane");
      return paneTemplateArgError(intent.template, intent.argText, context);
    };
    for (const query of ["PF Book", "PF book", "pf BOOK", "PF main", "PF Watchlist"]) expect(argError(query)).toBeNull();
    expect(argError("PF nope")).toEqual({
      message: 'No portfolio or watchlist named "nope"',
      detail: "Try Main Portfolio, Book or Watchlist",
    });
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
