/** @jsxImportSource react */
import { afterEach, expect, spyOn, test } from "bun:test";
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
import { insiderSignalsCache } from "./signals-client";

const InsiderView = insiderModule.panes![0]!.component;
const dom = createDomTestHarness({ withUi: false });
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
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

// GLO-326: a pane opened on Form 4s whose content was already loaded (another
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
function RankingPane() {
  const config = createTestPaneConfig(join(tmpdir(), "gloom-insider-signals-desktop-test"), { instanceId: RANKING_ID, paneId: "insider", title: "Insider Activity" });
  const [state, dispatch] = useReducer(appReducer, config, (initialConfig) => ({
    ...createInitialState(initialConfig),
    focusedPaneId: RANKING_ID,
    tickers: new Map(RANKING.rows.map((row) => [row.ticker, createTestTicker(row.ticker, row.company)])),
  }));
  rankingState = state;
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return (
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider>
        <WebDialogHostProvider>
          <TestPaneFrame state={state} dispatch={dispatch} paneId={RANKING_ID} pluginId="insider" runtime={runtime} width={120} height={24} footerKeys>
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
    signals: { clusterInsiders: 1, repeatBuys: 1, usualRatio: null, stakeIncreasePct: null, newPosition: false }, buyers: [],
  })),
};

async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await act(async () => { await Bun.sleep(20); });
}

test("the ranking opens a company in the same pane by keyboard and by double click", async () => {
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async () => RANKING);
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
  expect(container.textContent).toContain("3 insiders, $1.2M in 14 days");
  expect(container.textContent).toContain("as of Oct 14, 2026");

  await press("ArrowDown");
  await press("Enter");
  await until(() => pane().binding?.kind === "fixed");
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "CTSO" });
  expect(pane().title).toBe("INS CTSO");

  await press("Escape");
  await until(() => !!container.textContent?.includes("Northwind Biologics Inc"));
  expect(pane().binding).toEqual({ kind: "none" });

  const row = [...container.querySelectorAll("[data-gloom-role='data-table-row']")].find((element) => element.textContent?.includes("NWBI"));
  expect(row).toBeDefined();
  await act(async () => {
    row!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, button: 0 }) as unknown as Event);
    await Bun.sleep(10);
  });
  expect(pane().binding).toEqual({ kind: "fixed", symbol: "NWBI" });
}

test("the why chips wrap on one clipped row, a role with its first fact, so the browser drops whole chips", async () => {
  const director = { name: "Okafor Ben", role: "Director" } as const;
  spyOn(apiClient, "getCloudSecInsiderSignals").mockImplementation(async () => ({
    ...RANKING,
    side: "buy",
    rows: [{
      ...RANKING.rows[0]!,
      insiders: 3,
      whySignals: [
        { kind: "cluster", value: 3, text: "3 insiders", insider: null },
        { kind: "stake", value: 58, text: "+58%", insider: director },
        { kind: "repeat", value: 2, text: "2nd buy", insider: director },
      ],
    }],
  }));
  setSharedMarketDataCoordinator(new MarketDataCoordinator(createTestDataProvider({ getSecFilings: async () => [] })));
  await withViewport(() => checkChipRow());
});

async function checkChipRow() {
  const container = await dom.render(<RankingPane />);
  await until(() => container.querySelectorAll("[data-gloom-ui='badge']").length > 0);
  const badges = [...container.querySelectorAll("[data-gloom-ui='badge']")];
  expect(badges.map((badge) => badge.textContent)).toEqual(["3 insiders", "Director", "+58%", "2nd buy"]);
  // Badge > its holder > the unit > the row.
  const unit = (label: string) => badges.find((badge) => badge.textContent === label)!.parentElement!.parentElement as HTMLElement;
  const row = unit("3 insiders").parentElement as HTMLElement;
  expect(row.style.flexWrap).toBe("wrap");
  expect(row.style.overflow).toBe("hidden");
  expect(row.style.height).toBe("18px");
  expect(row.style.width).toBe("100%");
  // Nothing wide first, so a first chip too wide for the column wraps away too.
  expect((row.firstElementChild as HTMLElement).style.width).toBe("0px");
  expect(unit("Director")).toBe(unit("+58%"));
  expect(unit("2nd buy")).not.toBe(unit("+58%"));
  // Two cells before a group, one before another fact.
  expect([unit("3 insiders"), unit("Director"), unit("2nd buy")].map((element) => element.style.marginLeft)).toEqual(["0px", "16px", "8px"]);
}
