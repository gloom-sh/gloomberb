/** @jsxImportSource react */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useMemo, useReducer } from "react";
import { apiClient } from "../../../api-client";
import type { InsiderSignalsPayload } from "../../../api-client/insider-signals";
import { PaneContent } from "../../../components/layout/pane/content";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { WebDialogHostProvider } from "../../../renderers/dom/dialog-host";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { appReducer, createInitialState, type AppState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { noopRendererHost } from "../../../test-support/renderer-host";
import type { SecFilingItem } from "../../../types/data-provider";
import { findPaneInstance } from "../../../types/config";
import { UiHostProvider } from "../../../ui";
import { insiderModule } from "./index";
import { setSharedRegistryForTests, type PluginRegistry } from "../../registry";
import type { TickerMetadata } from "../../../types/ticker";
import { insiderSignalsCache } from "./signals-client";

const InsiderView = insiderModule.panes![0]!.component;
const dom = createDomTestHarness({ withUi: false });
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  mock.restore();
  setSharedMarketDataCoordinator(null);
  insiderSignalsCache.reset();
});

function Pane() {
  const paneId = "insider:desktop:test";
  const config = createTestPaneConfig("/tmp/unused-insider-desktop-test", { instanceId: paneId, paneId: "insider", binding: { kind: "fixed", symbol: "CONTROL" } });
  const [state, dispatch] = useReducer(appReducer, config, (initialConfig) => {
    const initial = createInitialState(initialConfig);
    initial.tickers = new Map([["CONTROL", createTestTicker("CONTROL")]]);
    initial.focusedPaneId = paneId;
    return initial;
  });
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <WebDialogHostProvider>
          <TestPaneFrame state={state} dispatch={dispatch} paneId={paneId} pluginId="ticker-research" runtime={runtime} width={100} height={30}>
            {(body) => <PaneContent component={InsiderView} paneId={paneId} paneType="insider" title="Insider" focused {...body} />}
          </TestPaneFrame>
        </WebDialogHostProvider>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

// A pane opened on Form 4s whose content was already loaded (another
// pane or an earlier visit read them) took them in one render each. On the web
// each of those renders is a nested update, and React stops the pane past 50.
test("opens on 60 already-read Form 4 filings without a render per filing", async () => {
  const filings: SecFilingItem[] = Array.from({ length: 60 }, (_, index) => ({
    accessionNumber: `f${index}`,
    form: "4",
    filingDate: new Date(Date.now() - (1 + index) * DAY_MS),
    cik: "999",
    filingUrl: `https://www.sec.gov/f${index}`,
  }));
  const content = (filing: SecFilingItem) => {
    const day = new Date(filing.filingDate).toISOString().slice(0, 10);
    return `<ownershipDocument><documentType>4</documentType><reportingOwner><reportingOwnerId><rptOwnerName>SMITH ANNA B</rptOwnerName><rptOwnerCik>111</rptOwnerCik></reportingOwnerId></reportingOwner><nonDerivativeTransaction><securityTitle><value>Class A</value></securityTitle><transactionDate><value>${day}</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></ownershipDocument>`;
  };
  const coordinator = new MarketDataCoordinator(createTestDataProvider({
    getSecFilings: async () => filings,
    getSecFilingContent: async (filing) => content(filing),
  }));
  setSharedMarketDataCoordinator(coordinator);
  await Promise.all(filings.map((filing) => coordinator.loadSecFilingContent(filing)));

  const container = await dom.render(<Pane />);
  for (let i = 0; i < 100 && !container.textContent?.includes("Buys and sells (60)"); i++) {
    await act(async () => { await Bun.sleep(20); });
  }
  const text = container.textContent ?? "";
  expect(text).not.toContain("stopped working");
  expect(text).toContain("Buys and sells (60)");
});

const RANKING_ID = "insider:ranking:desktop:test";
let rankingState: AppState | null = null;
function RankingPane({ width = 120, known = true }: { width?: number; known?: boolean } = {}) {
  const config = createTestPaneConfig(join(tmpdir(), "gloom-insider-signals-desktop-test"), { instanceId: RANKING_ID, paneId: "insider", title: "Insider Activity" });
  const [state, dispatch] = useReducer(appReducer, config, (initialConfig) => ({
    ...createInitialState(initialConfig),
    focusedPaneId: RANKING_ID,
    tickers: new Map(known ? RANKING.rows.map((row) => [row.ticker, createTestTicker(row.ticker, row.company)]) : []),
  }));
  rankingState = state;
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <WebDialogHostProvider>
          <TestPaneFrame state={state} dispatch={dispatch} paneId={RANKING_ID} pluginId="insider" runtime={runtime} width={width} height={24} footerKeys>
            {(body) => <PaneContent component={InsiderView} paneId={RANKING_ID} paneType="insider" title="Insider Activity" focused {...body} />}
          </TestPaneFrame>
        </WebDialogHostProvider>
      </WebInputHostProvider>
    </UiHostProvider>
  );
}

// Invented companies and people.
const RANKING: InsiderSignalsPayload = {
  window: 30, through: "2026-10-15", asOf: "2026-10-14", coverage: { from: "2026-08-31", through: "2026-10-14" },
  rows: [["NWBI", "Northwind Biologics Inc", "3 insiders, $1.2M in 14 days"], ["CTSO", "Contoso Energy Corp", "CEO's 4th buy in 90 days, 4.9x usual size"]].map(([ticker, company, reason], index) => ({
    ticker: ticker!, issuerCik: `990000${index}`, company: company!, score: 78 - index * 6, reasons: [reason!], insiders: 1, buys: 1, value: 500_000,
    shares: 10_000, firstBuy: "2026-10-01", lastBuy: "2026-10-14", lastFiled: "2026-10-14",
    signals: { clusterInsiders: 1, repeatBuys: 1, usualRatio: null, stakeIncreasePct: null, newPosition: false },
    buyers: [{ name: "Rivera Ana", role: index ? "CFO" : "CEO", value: 500_000, buys: 1, lastBuy: "2026-10-14", repeatBuys: index + 1, usualRatio: null }],
  })),
};

async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await act(async () => { await Bun.sleep(20); });
}

test("the ranking opens a company's INS in its detail by keyboard and by click, Back in its query bar, and Back returns", async () => {
  // A company asks for itself: its row on each side.
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async (params = {}) => (params.ticker
    ? { ...RANKING, side: params.side ?? "buy", ticker: params.ticker, rows: params.side === "sell" ? [] : RANKING.rows.filter((row) => row.ticker === params.ticker) }
    : RANKING));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => [] })));
  const pane = () => findPaneInstance(rankingState!.config.layout, RANKING_ID)!;
  const press = async (key: string) => {
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      await Bun.sleep(10);
    });
  };

  await withViewport(() => openRanking(pane, press));
});

/** happy-dom has no layout, so give the table body a viewport tall enough for every row. */
async function withViewport(run: () => Promise<void>) {
  const saved = ["offsetHeight", "clientHeight"].map((property) => [property, Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, property)] as const);
  for (const [property] of saved) Object.defineProperty(dom.window.HTMLElement.prototype, property, { configurable: true, value: 18 * 20 });
  try {
    await run();
  } finally {
    for (const [property, descriptor] of saved) {
      if (descriptor) Object.defineProperty(dom.window.HTMLElement.prototype, property, descriptor);
      else delete (dom.window.HTMLElement.prototype as unknown as Record<string, unknown>)[property];
    }
  }
}

async function openRanking(pane: () => ReturnType<typeof findPaneInstance> & object, press: (key: string) => Promise<void>) {
  const container = await dom.render(<RankingPane />);
  await until(() => !!container.textContent?.includes("Contoso Energy Corp"));
  expect(container.textContent).toContain("2nd");
  expect(container.textContent).toContain("as of Oct 14, 2026");

  // The stack's title, ticker and company, shows only while a company is open.
  const opened = () => !!container.textContent?.includes(" \u00b7 ");
  await press("ArrowDown");
  await press("Enter");
  await until(() => opened() && !!container.textContent?.includes("Ana Rivera"));
  // The company named once, in the stack's title; the pane stays the ranking.
  expect(container.textContent).toContain("CTSO \u00b7 Contoso Energy Corp");
  expect(container.textContent).not.toContain("Northwind Biologics Inc");
  expect(pane().binding?.kind ?? "none").toBe("none");
  // One toolbar: Back and the company lead INS's own query bar, its Window and its views.
  const bars = container.querySelectorAll("[data-gloom-role='page-stack-header']");
  expect(bars.length).toBe(0);
  const bar = container.querySelector(".gloom-qb");
  expect(bar?.textContent).toContain("Back");
  expect(bar?.textContent).toContain("CTSO \u00b7 Contoso Energy Corp");
  expect(bar?.textContent).toContain("Trades");
  expect(bar?.textContent).toContain("Insiders");
  // Its insider in the ranking's terms: the CFO's 2nd buy.
  expect(container.textContent).toContain("2nd");

  await press("Escape");
  await until(() => !!container.textContent?.includes("Northwind Biologics Inc"));
  expect(opened()).toBe(false);
  // Back lands on the row it opened. Opened again, drawn at once from the
  // ticker it now knows, Back still sits in the one bar.
  await press("Enter");
  await until(opened);
  expect(container.textContent).toContain("CTSO \u00b7 Contoso Energy Corp");
  expect(container.querySelectorAll("[data-gloom-role='page-stack-header']").length).toBe(0);
  expect(container.querySelector(".gloom-qb")?.textContent).toContain("Back");
  await press("Escape");
  await until(() => !opened());

  const row = [...container.querySelectorAll("[data-gloom-role='data-table-row']")].find((element) => element.textContent?.includes("NWBI"));
  expect(row).toBeDefined();
  await act(async () => {
    row!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }) as unknown as Event);
    await Bun.sleep(10);
  });
  await until(opened);
  expect(container.textContent).toContain("NWBI \u00b7 Northwind Biologics Inc");
}

// On the desktop an opened company's bar also holds Back and its name, so its
// Type choices go to a menu where a pane of its own would still show them all:
// the 80 cells they need, and Back (8) and "CTSO · Contoso Energy Corp" (26) with its padding (2).
test("an opened company's trades keep the Type choices in a menu where Back and the name leave no room", async () => {
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async (params = {}) => (params.ticker
    ? { ...RANKING, side: params.side ?? "buy", ticker: params.ticker, rows: params.side === "sell" ? [] : RANKING.rows.filter((row) => row.ticker === params.ticker) }
    : RANKING));
  const filing: SecFilingItem = { accessionNumber: "a1", form: "4", filingDate: new Date(Date.now() - 2 * DAY_MS), cik: "9900001", filingUrl: "https://www.sec.gov/a1" };
  const day = new Date(filing.filingDate).toISOString().slice(0, 10);
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
    getSecFilings: async () => [filing],
    getSecFilingContent: async () => `<ownershipDocument><documentType>4</documentType><reportingOwner><reportingOwnerId><rptOwnerName>RIVERA ANA</rptOwnerName><rptOwnerCik>111</rptOwnerCik></reportingOwnerId></reportingOwner><nonDerivativeTransaction><securityTitle><value>Common</value></securityTitle><transactionDate><value>${day}</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>100</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></ownershipDocument>`,
  })));
  await withViewport(async () => {
    for (const [width, inline] of [[115, false], [116, true]] as const) {
      const container = await dom.render(<RankingPane width={width} />);
      await until(() => !!container.textContent?.includes("Contoso Energy Corp"));
      const row = [...container.querySelectorAll("[data-gloom-role='data-table-row']")].find((element) => element.textContent?.includes("CTSO"));
      await act(async () => {
        row!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }) as unknown as Event);
        await Bun.sleep(10);
      });
      await until(() => !!container.querySelector(".gloom-qb-view"));
      const trades = [...container.querySelectorAll(".gloom-qb-view button")].find((button) => button.textContent === "Trades") as HTMLElement;
      await act(async () => {
        trades.click();
        await Bun.sleep(10);
      });
      await until(() => !!container.textContent?.includes("Buys and sells (1)"));
      expect(container.querySelector(".gloom-qb")?.textContent).toContain("CTSO \u00b7 Contoso Energy Corp");
      expect(!!container.querySelector(".gloom-qb-inline[data-item-id='type']")).toBe(inline);
    }
  });
});

// A company the app has not seen is looked up first; Back before the lookup
// answers leaves no trace of it: nothing saved, nothing added, no search offered.
test("Back while an unseen company is looked up leaves nothing behind; a lookup that answers adds it as an open does", async () => {
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async () => RANKING);
  let answer: (() => void) | null = null;
  const created: string[] = [];
  const emitted: string[] = [];
  setSharedRegistryForTests({
    marketData: createTestDataProvider({
      search: async (query) => {
        await new Promise<void>((resolve) => { answer = resolve; });
        return [{ providerId: "test", symbol: query, name: "Contoso Energy Corp", exchange: "NASDAQ", currency: "USD", type: "EQUITY" }];
      },
    }),
    tickerRepository: {
      loadAllTickers: async () => [],
      loadTicker: async () => null,
      saveTicker: async () => {},
      createTicker: async (metadata: TickerMetadata) => { created.push(metadata.ticker); return createTestTicker(metadata.ticker, metadata.name); },
      deleteTicker: async () => {},
    },
    events: { emit: (name: string) => { emitted.push(name); } },
  } as unknown as PluginRegistry);
  try {
    await withViewport(async () => {
      const container = await dom.render(<RankingPane known={false} />);
      await until(() => !!container.textContent?.includes("Contoso Energy Corp"));
      const open = async () => {
        const row = [...container.querySelectorAll("[data-gloom-role='data-table-row']")].find((element) => element.textContent?.includes("CTSO"));
        await act(async () => {
          row!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }) as unknown as Event);
          await Bun.sleep(10);
        });
      };
      await open();
      await until(() => !!container.textContent?.includes("Opening CTSO...") && answer != null);
      await act(async () => {
        (container.querySelector("[data-gloom-role='page-stack-header'] button") as HTMLElement).click();
        await Bun.sleep(10);
      });
      await until(() => !!container.textContent?.includes("Northwind Biologics Inc"));
      await act(async () => {
        answer!();
        await Bun.sleep(50);
      });
      expect([created, emitted, [...rankingState!.tickers.keys()]]).toEqual([[], [], []]);
      expect(container.querySelector(".gloom-command-bar, [data-gloom-role='command-bar']")).toBeNull();

      // Opened again and left to answer: saved, added and announced once.
      answer = null;
      await open();
      await until(() => answer != null);
      await act(async () => {
        answer!();
        await Bun.sleep(50);
      });
      await until(() => rankingState!.tickers.has("CTSO"));
      expect([created, emitted]).toEqual([["CTSO"], ["ticker:added"]]);
    });
  } finally {
    setSharedRegistryForTests(undefined);
  }
});

// A company opened from the ranking keeps its trade, Insider and Type only
// while it is open: the outer Back with a trade still open, then the same
// company again, finds Trades as a first visit would.
test("a company opened again starts clean: no trade left open, no insider or type left from the last visit", async () => {
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async (params = {}) => (params.ticker
    ? { ...RANKING, side: params.side ?? "buy", ticker: params.ticker, rows: params.side === "sell" ? [] : RANKING.rows.filter((row) => row.ticker === params.ticker) }
    : RANKING));
  const day = new Date(Date.now() - 2 * DAY_MS);
  const filings: SecFilingItem[] = ["a1", "a2"].map((accessionNumber) => ({ accessionNumber, form: "4", filingDate: day, cik: "9900001", filingUrl: `https://www.sec.gov/${accessionNumber}` }));
  const line = (owner: string, code: string, shares: number) => `<ownershipDocument><documentType>4</documentType><reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName><rptOwnerCik>${owner.length}</rptOwnerCik></reportingOwnerId></reportingOwner><nonDerivativeTransaction><securityTitle><value>Common</value></securityTitle><transactionDate><value>${day.toISOString().slice(0, 10)}</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></ownershipDocument>`;
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({
    getSecFilings: async () => filings,
    getSecFilingContent: async (filing) => filing.accessionNumber === "a1" ? line("RIVERA ANA", "P", 100) : line("OKAFOR BEN", "M", 300),
  })));
  await withViewport(async () => {
    const container = await dom.render(<RankingPane />);
    await until(() => !!container.textContent?.includes("Contoso Energy Corp"));
    const rows = () => [...container.querySelectorAll("[data-gloom-role='data-table-row']")];
    const dblclick = async (text: string) => {
      const row = rows().find((element) => element.textContent?.includes(text));
      expect(row).toBeDefined();
      await act(async () => {
        row!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }) as unknown as Event);
        await Bun.sleep(10);
      });
    };
    const click = async (element: Element | null | undefined) => {
      expect(element).toBeTruthy();
      await act(async () => {
        (element as HTMLElement).click();
        await Bun.sleep(10);
      });
    };
    const bands = () => container.querySelectorAll("[data-gloom-role='page-stack-header']");
    const typeChoice = () => [...(container.querySelector(".gloom-qb-inline[data-item-id='type']")?.querySelectorAll("button") ?? [])]
      .find((button) => button.getAttribute("data-active") === "true")?.textContent ?? "";
    const insiderChoice = () => [...container.querySelectorAll(".gloom-qb-chip")].find((chip) => chip.textContent?.startsWith("Insider"))?.textContent ?? "";

    // First visit: Ana Rivera's trades, every type, one trade opened.
    await dblclick("CTSO");
    await until(() => rows().some((row) => row.textContent?.includes("Ana Rivera")));
    await dblclick("Ana Rivera");
    await until(() => insiderChoice().includes("Ana Rivera") && typeChoice().startsWith("Buys and sells"));
    await click([...container.querySelectorAll(".gloom-qb-inline[data-item-id='type'] button")].find((button) => button.textContent?.startsWith("All")));
    await until(() => typeChoice().startsWith("All"));
    await dblclick("BUY");
    await until(() => bands().length === 2);

    // The outer Back, the trade still open: the ranking, and nothing of the visit kept in its pane state.
    await click(bands()[0]!.querySelector("button"));
    await until(() => !!container.textContent?.includes("Northwind Biologics Inc"));
    const kept = rankingState!.paneState[RANKING_ID]?.pluginState?.insider ?? {};
    expect(Object.keys(kept).filter((key) => /^insider:(nameFilter|selectedId|openItemId|typeFilter)/.test(key))).toEqual([]);

    // Again: Insiders first, then Trades as a first visit has it.
    await dblclick("CTSO");
    await until(() => !!container.querySelector(".gloom-qb-view"));
    // The view strip; an inline filter's choices are segments of the same look.
    const viewButtons = () => [...[...container.querySelectorAll(".gloom-qb-view")].find((strip) => !strip.classList.contains("gloom-qb-segments"))!.querySelectorAll("button")];
    expect(viewButtons().find((button) => button.getAttribute("data-active") === "true")?.textContent).toBe("Insiders");
    await click(viewButtons().find((button) => button.textContent === "Trades"));
    await until(() => typeChoice() !== "");
    expect(bands().length).toBe(0);
    expect(insiderChoice()).toContain("All");
    expect(typeChoice()).toStartWith("Buys and sells");
    expect(container.textContent).not.toContain("Transaction Date");
  });
});

test("why is columns on the desktop: figures right in the side's tone, NEW bold, the both-ways mark muted, each column sorted from its header", async () => {
  const director = { name: "Okafor Ben", role: "Director" } as const;
  const base = RANKING.rows[0]!;
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async () => ({
    ...RANKING,
    side: "buy",
    rows: [
      { ...base, insiders: 3, buyers: [
        { ...director, value: 400_000, buys: 2, lastBuy: "2026-10-14", stakeChangePct: 58, repeatBuys: 2, usualRatio: 3.1 },
        { name: "Rivera Ana", role: "CEO", value: 100_000, buys: 1, lastBuy: "2026-10-13", newPosition: true, repeatBuys: 1, usualRatio: null },
      ] },
      { ...base, ticker: "CTSO", company: "Contoso Energy Corp", score: 60, buyers: [
        { ...director, value: 300_000, buys: 1, lastBuy: "2026-10-12", newPosition: true, repeatBuys: 1, usualRatio: null },
      ] },
      { ...base, ticker: "WWIM", company: "Wide World Importers", score: 50, buyers: [
        { ...director, value: 200_000, buys: 3, lastBuy: "2026-10-11", stakeChangePct: 4, twoWay: true, repeatBuys: null, usualRatio: null },
      ] },
    ],
  }));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => [] })));
  await withViewport(() => checkColumns());
});

async function checkColumns() {
  const container = await dom.render(<RankingPane />);
  await until(() => !!container.textContent?.includes("Wide World Importers"));
  const headers = () => [...container.querySelectorAll("[data-gloom-role='data-table-header-cell']")] as HTMLElement[];
  expect(headers().map((header) => header.textContent?.replace(/[▲▼]/g, "").trim().toUpperCase()))
    .toEqual(["TICKER", "COMPANY", "SCORE", "ROLE", "NTH", "VS USUAL", "STAKE", "BUYERS", "BOUGHT", "LAST BUY"]);
  expect(container.querySelector("[data-gloom-ui='badge']")).toBeNull();
  const cells = (ticker: string) => [...[...container.querySelectorAll("[data-gloom-role='data-table-row']")]
    .find((row) => row.textContent?.includes(ticker))!
    .querySelectorAll("[data-gloom-role='data-table-cell']")] as HTMLElement[];
  const column = (label: string) => headers().findIndex((header) => header.textContent?.toUpperCase().includes(label));
  const text = (ticker: string, label: string) => cells(ticker)[column(label)]!.textContent;
  expect(["ROLE", "NTH", "VS USUAL", "STAKE"].map((label) => text("NWBI", label))).toEqual(["Director +2", "2nd", "3.1x", "+58%"]);
  expect(["ROLE", "NTH", "VS USUAL", "STAKE"].map((label) => text("CTSO", label))).toEqual(["Director", "1st", "--", "NEW"]);
  // The figure and its mark are two runs: the mark in the muted tone, never the figure's.
  const both = cells("WWIM")[column("STAKE")]!;
  const runs = [...both.querySelectorAll("span")].filter((span) => span.children.length === 0 && span.textContent?.trim());
  expect(runs.map((span) => span.textContent?.trim())).toEqual(["+4%", "\u00b1"]);
  expect(runs[0]!.style.color).not.toBe(runs[1]!.style.color);
  const fresh = [...cells("CTSO")[column("STAKE")]!.querySelectorAll("span")].find((span) => span.textContent === "NEW") as HTMLElement;
  expect(fresh.style.fontWeight).toBe("700");
  // Numbers right-aligned: plain cells by the column, the marked one by its content.
  expect((cells("NWBI")[column("STAKE")]!.querySelector("span") as HTMLElement).style.textAlign).toBe("right");
  expect((both.firstElementChild as HTMLElement).style.justifyContent).toBe("flex-end");

  // A header sorts its column, largest first: NEW above any raise; the dash last.
  const order = () => [...container.querySelectorAll("[data-gloom-role='data-table-row']")].map((row) => row.textContent?.slice(0, 4));
  const click = async (label: string) => {
    await act(async () => {
      headers()[column(label)]!.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
      await Bun.sleep(10);
    });
  };
  await click("STAKE");
  expect(order()).toEqual(["CTSO", "NWBI", "WWIM"]);
  await click("VS USUAL");
  expect(order()).toEqual(["NWBI", "CTSO", "WWIM"]);
  await click("VS USUAL");
  expect(order()).toEqual(["NWBI", "CTSO", "WWIM"]);
  await click("NTH");
  expect(order()).toEqual(["NWBI", "CTSO", "WWIM"]);
}
