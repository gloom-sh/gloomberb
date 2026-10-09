/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { act, useMemo, useReducer } from "react";
import { PaneContent } from "../../../components/layout/pane/content";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { WebDialogHostProvider } from "../../../renderers/dom/dialog-host";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { WebInputHostProvider } from "../../../renderers/dom/input-host";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { noopRendererHost } from "../../../test-support/renderer-host";
import type { SecFilingItem } from "../../../types/data-provider";
import { UiHostProvider } from "../../../ui";
import { insiderModule } from "./index";

const InsiderView = insiderModule.panes![0]!.component;
const dom = createDomTestHarness({ withUi: false });
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => setSharedMarketDataCoordinator(null));

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
