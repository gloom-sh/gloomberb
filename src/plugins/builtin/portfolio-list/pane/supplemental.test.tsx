import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import { PluginRenderProvider } from "../../../runtime";
import { createTestDataProvider, createTestFinancials } from "../../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createTestTicker } from "../../../../test-support/ticker";
import type { ColumnConfig } from "../../../../types/config";
import type { CorporateActionsData, TickerFinancials } from "../../../../types/financials";
import { usePortfolioSupplementalData, type PortfolioSupplementalData } from "./supplemental";

const tui = createOpenTuiTestHarness();

test("a fund's history read before another fund joined DIV%'s rows still lands, and is not asked for again", async () => {
  const settle = new Map<string, () => void>();
  const requests: string[] = [];
  const provider = createTestDataProvider({
    getCorporateActions: (symbol: string) => {
      requests.push(symbol);
      return new Promise<CorporateActionsData>((resolve) => settle.set(symbol, () => resolve({
        symbol, currency: "USD", coverage: { dividends: "available" }, dividends: [], splits: [], earnings: [],
      })));
    },
  });
  const runtime = createTestPluginRuntime({ getMarketData: () => provider });
  const tickers = [createTestTicker("AAA", "A fund"), createTestTicker("BBB", "B fund")];
  const columns: ColumnConfig[] = [{ id: "dividend_yield", label: "DIV%", width: 7, align: "right" }];
  // DIV% reads the history of a trailing yield; a row joins once its fundamentals say so.
  const trailing = createTestFinancials({ fundamentals: { dividendYield: 0.05, dividendYieldBasis: "trailing" } });
  let latest!: PortfolioSupplementalData;
  let setFinancials!: (financials: Map<string, TickerFinancials>) => void;
  function Probe() {
    const [financials, set] = useState(() => new Map([["AAA", trailing]]));
    setFinancials = set;
    latest = usePortfolioSupplementalData(tickers, columns, true, financials);
    return null;
  }

  await act(async () => {
    await tui.render(<PluginRenderProvider pluginId="portfolio-list" runtime={runtime}><Probe /></PluginRenderProvider>, { width: 10, height: 2 });
  });
  expect(requests).toEqual(["AAA"]);
  // BBB's fundamentals arrive while AAA is read: the rows change under AAA's batch, and BBB is read beside it.
  await act(async () => setFinancials(new Map([["AAA", trailing], ["BBB", trailing]])));
  expect(requests).toEqual(["AAA", "BBB"]);
  await act(async () => settle.get("BBB")!());
  // AAA settles last, after the effect that asked for it re-ran: nothing else would ask again.
  await act(async () => settle.get("AAA")!());
  expect([...latest.corporateActions.keys()].sort()).toEqual(["AAA", "BBB"]);
  expect(requests).toEqual(["AAA", "BBB"]);
});
