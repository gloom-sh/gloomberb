import { afterEach, expect, test } from "bun:test";
import { act, useMemo, useState } from "react";
import { PaneFooterBar, PaneFooterProvider, type CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { AppPersistence } from "../../../data/app-persistence";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { emitKeypress, settleFrame, testRender } from "../../../renderers/opentui/test-utils";
import { AssetDataRouter } from "../../../sources/provider-router";
import { createInitialState } from "../../../state/app/context";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { TestPaneProvider, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createStatefulTestPluginRuntime } from "../../../test-support/plugin-runtime";
import type { DataProvider, SecFilingItem } from "../../../types/data-provider";
import { Box } from "../../../ui";
import { secHeadless, secModule } from "./index";

const PANE_ID = "sec:test";
const Pane = secModule.panes![0]!.component;
const filing: SecFilingItem = {
  accessionNumber: "0000000001-26-000001",
  form: "8-K",
  filingDate: new Date("2026-09-10T00:00:00Z"),
  cik: "1",
  companyName: "ACME issuer",
  primaryDocument: "current.htm",
  filingUrl: "https://www.sec.gov/Archives/1/filing-index.htm",
  primaryDocumentUrl: "https://www.sec.gov/Archives/1/current.htm",
};
const primaryDocument = { document: "current.htm", type: "8-K", url: filing.primaryDocumentUrl!, isPrimary: true };

let setup: Awaited<ReturnType<typeof testRender>> | null = null;
let coordinator: MarketDataCoordinator | null = null;
let footer: CombinedPaneFooter;
let selectCompany: (symbol: string) => void;

function Harness() {
  const [symbol, setSymbol] = useState("ACME");
  selectCompany = setSymbol;
  const config = createTestPaneConfig("/tmp/gloomberb-sec-test", {
    instanceId: PANE_ID,
    paneId: "sec",
    binding: { kind: "fixed", symbol },
  });
  const state = createInitialState(config);
  state.tickers = new Map([[symbol, createTestTicker(symbol)]]);
  state.focusedPaneId = PANE_ID;
  const runtime = useMemo(() => createStatefulTestPluginRuntime(), []);
  return (
    <TestPaneProvider state={state} paneId={PANE_ID} pluginId="ticker-research" runtime={runtime}>
      <PaneFooterProvider>
        {(value) => {
          footer = value;
          return (
            <Box width={110} height={36} flexDirection="column">
              <Box height={35}><Pane paneId={PANE_ID} paneType="sec" focused width={110} height={35} /></Box>
              <PaneFooterBar footer={value} focused width={110} />
            </Box>
          );
        }}
      </PaneFooterProvider>
    </TestPaneProvider>
  );
}

async function mount(provider: DataProvider) {
  coordinator = new MarketDataCoordinator(provider);
  setSharedMarketDataCoordinator(coordinator);
  await act(async () => { setup = await testRender(<Harness />, { width: 110, height: 36 }); });
  await settleFrame(setup!, 8);
}

async function press(name: string, sequence: string) {
  await emitKeypress(setup!, { name, sequence });
}

function frame() {
  return setup!.captureCharFrame();
}

afterEach(async () => {
  if (setup) await act(async () => setup!.renderer.destroy());
  setup = null;
  coordinator?.destroy();
  coordinator = null;
  setSharedMarketDataCoordinator(null);
});

test("SEC reports document failures honestly and plain refresh retries only failed reading", async () => {
  let recovered = false;
  const calls: string[] = [];
  const provider = createTestDataProvider({
    getSecFilings: async () => {
      calls.push("filings");
      return [filing];
    },
    getSecFilingDocuments: async () => {
      calls.push("documents");
      if (!recovered) throw new Error("Document index outage");
      return [primaryDocument];
    },
    getSecFilingContent: async () => {
      calls.push("content");
      if (!recovered) throw new Error("Primary document outage");
      return "Recovered acquisition agreement terms";
    },
  });
  await mount(provider);
  await press("return", "\r");
  await settleFrame(setup!, 12);
  const failed = frame();
  expect(calls).toContain("documents");
  expect(calls).toContain("content");
  expect(failed).not.toContain("No filing documents were listed");
  expect(failed).toContain("Document index outage");
  expect(failed).toContain("Primary document outage");

  recovered = true;
  const count = calls.length;
  await press("r", "r");
  await settleFrame(setup!, 8);
  expect(calls.length).toBe(count + 3);
  expect(frame()).toContain("Recovered acquisition");
  expect(JSON.stringify(footer)).not.toContain("outage");

  const reads = calls.filter((call) => call !== "filings").length;
  await press("r", "r");
  await settleFrame(setup!, 8);
  expect(calls.filter((call) => call !== "filings").length).toBe(reads);
});

test("cached router failures retry and true empty document results stay distinct", async () => {
  const persistence = new AppPersistence(":memory:");
  let failed = true;
  let documents = 0;
  let contents = 0;
  const provider = createTestDataProvider({
    id: "test-sec",
    getSecFilings: async () => [filing],
    getSecFilingDocuments: async () => {
      documents++;
      if (failed) throw new Error("Cached index outage");
      return [];
    },
    getSecFilingContent: async () => {
      contents++;
      if (failed) throw new Error("Cached primary outage");
      return "Recovered cached primary document";
    },
  });
  try {
    await mount(new AssetDataRouter(provider, [], persistence.resources));
    await press("return", "\r");
    await settleFrame(setup!, 12);
    expect(frame()).toContain("Cached index outage");

    failed = false;
    await press("r", "r");
    await settleFrame(setup!, 12);
    const recovered = frame();
    expect(documents).toBe(2);
    expect(contents).toBe(2);
    expect(recovered).toContain("No filing documents were listed");
    expect(recovered).toContain("Recovered cached primary document");
    expect(JSON.stringify(footer)).not.toContain("outage");
  } finally {
    await act(async () => setup!.renderer.destroy());
    setup = null;
    coordinator!.destroy();
    coordinator = null;
    setSharedMarketDataCoordinator(null);
    persistence.close();
  }
});

test("SEC refresh joins an active request and preserves filing ownership across companies", async () => {
  let finish!: (rows: SecFilingItem[]) => void;
  const calls: string[] = [];
  const second: SecFilingItem = {
    ...filing,
    accessionNumber: "0000000002-26-000002",
    companyName: "SECOND issuer",
    cik: "2",
    primaryDocumentUrl: "https://www.sec.gov/Archives/2/current.htm",
    filingUrl: "https://www.sec.gov/Archives/2/index.htm",
  };
  const provider = createTestDataProvider({
    getSecFilings: async (symbol) => {
      calls.push(symbol);
      return symbol === "ACME" ? new Promise<SecFilingItem[]>((resolve) => { finish = resolve; }) : [second];
    },
    getSecFilingDocuments: async () => [],
    getSecFilingContent: async (item) => `Only ${item.companyName} source terms`,
  });
  await mount(provider);
  await press("r", "r");
  await settleFrame(setup!, 6);
  expect(calls).toEqual(["ACME"]);

  await act(async () => selectCompany("SECOND"));
  await settleFrame(setup!, 8);
  await press("return", "\r");
  await settleFrame(setup!, 10);
  expect(frame()).toContain("Only SECOND issuer source terms");

  await act(async () => finish([filing]));
  await settleFrame(setup!, 8);
  const after = frame();
  expect(after).toContain("Only SECOND issuer source terms");
  expect(after).not.toContain("ACME issuer");
  expect(coordinator!.getSecContentEntry(second.accessionNumber).data).toBe("Only SECOND issuer source terms");
});

test("as-filed originals and amendments retain independent detail and headless accession/date identity", async () => {
  const amendment: SecFilingItem = {
    ...filing,
    accessionNumber: "0000000001-26-000003",
    form: "8-K/A",
    filingDate: new Date("2026-09-11T00:00:00Z"),
    acceptedAt: new Date("2026-09-11T21:05:00Z"),
    acceptedAtRaw: "2026-09-11T21:05:00Z",
    filingUrl: "https://www.sec.gov/Archives/1/amendment-index.htm",
    primaryDocumentUrl: "https://www.sec.gov/Archives/1/amendment.htm",
  };
  const provider = createTestDataProvider({
    getSecFilings: async () => [amendment, filing],
    getSecFilingDocuments: async () => [],
    getSecFilingContent: async (item) => `As filed ${item.form}, accession ${item.accessionNumber}`,
  });
  await mount(provider);
  await press("return", "\r");
  await settleFrame(setup!, 10);
  expect(frame()).toContain("As filed 8-K/A, accession 0000000001-26-000003");

  await press("escape", "\x1b");
  await press("down", "j");
  await press("return", "\r");
  await settleFrame(setup!, 8);
  expect(frame()).toContain("As filed 8-K, accession 0000000001-26-000001");

  const report = await secHeadless.load(
    { rawArgument: "ACME", argument: "ACME", symbols: ["ACME"], options: { limit: 50 } },
    { marketData: provider, signal: new AbortController().signal } as never,
  );
  expect(report.rows.map((row) => row.accessionNumber)).toEqual([amendment.accessionNumber, filing.accessionNumber]);
  expect(report.rows[0]).toMatchObject({
    form: "8-K/A",
    filedAt: "2026-09-11T00:00:00.000Z",
    acceptedAt: "2026-09-11T21:05:00.000Z",
    url: amendment.filingUrl,
  });
  expect(report.rows[1]!.acceptedAt).toBeNull();
});

test("discovery refresh failure preserves the opened as-filed document and its source action", async () => {
  let failed = false;
  let reads = 0;
  const provider = createTestDataProvider({
    getSecFilings: async () => {
      if (failed) throw new Error("Discovery outage");
      return [filing];
    },
    getSecFilingDocuments: async () => [primaryDocument],
    getSecFilingContent: async () => {
      reads++;
      return "Immutable acquisition source terms";
    },
  });
  await mount(provider);
  await press("return", "\r");
  await settleFrame(setup!, 10);

  failed = true;
  await press("r", "r");
  await settleFrame(setup!, 8);
  expect(frame()).toContain("Immutable acquisition source terms");
  expect(JSON.stringify(footer)).toContain("Discovery outage");
  expect(footer.hints.some((hint) => hint.id === "open")).toBe(true);
  expect(reads).toBe(1);

  failed = false;
  await press("r", "r");
  await settleFrame(setup!, 8);
  expect(JSON.stringify(footer)).not.toContain("Discovery outage");
  expect(reads).toBe(1);
});
