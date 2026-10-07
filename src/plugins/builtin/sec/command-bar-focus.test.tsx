import { beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import type { SecFilingItem } from "../../../types/data-provider";
import { createSecFilingSearchProvider, resetSecFilingFocusRequests, useSecFilingFocusRequest } from "./command-bar-search";

const tui = createOpenTuiTestHarness({ width: 40, height: 4 });
beforeEach(resetSecFilingFocusRequests);

const tenK: SecFilingItem = {
  accessionNumber: "0000320193-25-000079",
  form: "10-K",
  filingDate: new Date("2025-10-31T00:00:00Z"),
  cik: "0000320193",
  companyName: "Apple Inc.",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/0000320193-25-000079-index.htm",
};

function View({ symbol, opened }: { symbol: string; opened: string[] }) {
  useSecFilingFocusRequest(symbol, (accession) => { opened.push(accession); });
  return <text>{symbol}</text>;
}

test("a view already on the ticker cannot take the filing away from the SEC pane being opened", async () => {
  const provider = createSecFilingSearchProvider(
    { createPaneFromTemplate: () => {} },
    {
      getCoordinator: () => ({ loadSecFilings: async () => ({ data: [tenK], lastGoodData: null }) as never }),
      now: () => Date.parse("2026-10-05T12:00:00Z"),
    },
  );
  const [row] = await provider.provide("AAPL 10-K", { activeTicker: null, activeCollectionId: null }, new AbortController().signal);

  // A Ticker Research SEC tab on AAPL is already mounted when the row runs.
  const researchTab: string[] = [];
  await tui.render(<View symbol="AAPL" opened={researchTab} />);
  await act(async () => { await row!.execute(); });
  expect(researchTab).toEqual([tenK.accessionNumber]);

  // The SEC pane created for the row mounts afterwards and still opens the filing.
  const secPane: string[] = [];
  await tui.render(<View symbol="AAPL" opened={secPane} />);
  await tui.renderFrames(1);
  expect(secPane).toEqual([tenK.accessionNumber]);
});
