import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContractTermsPayload } from "../../../api-client/futures-curve";
import { buildTickerReport } from "../../../cli/commands/ticker";
import { marketDataCliCommands } from "../../../cli/commands/market";
import { DEFAULT_CLI_OPTIONS } from "../../../cli/options";
import { serializeCliResult } from "../../../cli/result";
import { createOpenTuiTestHarness, settleFrame } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestCliContext, type PrintedCliResult } from "../../../test-support/cli-context";
import { createTestFinancials, createTestQuote } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import { createDefaultConfig } from "../../../types/config";
import type { Quote } from "../../../types/financials";
import { OverviewTab } from "./overview-tab";
import { futuresContractCache } from "./overview/futures-contract";

const config = createDefaultConfig("/tmp/gloom-futures-contract-test-unused");
const tui = createOpenTuiTestHarness();
const terms: FuturesContractTermsPayload = {
  symbol: "GC=F", root: "GC", name: "Gold", contract: "GCZ26", contractSymbol: "GCZ26.CMX", deliveryMonth: "2026-12",
  spec: { unit: "USD / troy oz", size: "100 troy oz", pointValue: 100, tick: 0.1, tickValue: 10, settlement: "physical" },
  lastTrade: "2026-12-29", firstNotice: "2026-11-30", inDelivery: false, settlement: { price: 4216.3, date: "2026-10-09" },
};
const futuresQuote = createTestQuote({ symbol: "GC=F", name: "Gold Dec 26", price: 4216.3, change: 59.3, changePercent: 1.43, instrumentType: "FUTURE" });

afterEach(() => { futuresContractCache.reset(); });

const CASES = [
  { name: "a confirmed settlement", quote: futuresQuote, answer: terms, settle: "$4,216.30 (2026-10-09)" },
  { name: "no confirmed settlement", quote: futuresQuote, answer: { ...terms, settlement: null }, settle: "--" },
  { name: "a server without the route", quote: futuresQuote, answer: new ApiRequestError("Not found", 404), settle: null },
  { name: "a stock", quote: createTestQuote({ symbol: "AAPL", name: "Apple Inc.", price: 336.64, instrumentType: "EQUITY" }), answer: terms, settle: null },
] as const;

for (const { name, quote, answer, settle } of CASES) {
  test(`quote, ticker and the Overview agree on ${name}`, async () => {
    const loads = spyOn(apiClient, "getCloudFuturesContract").mockImplementation(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    try {
      const cli = createTestCliContext({ config, dataProvider: {
        getQuotesBatch: async () => [{ target: { symbol: quote.symbol, exchange: "" }, quote }],
      } });
      await marketDataCliCommands.find((command) => command.name === "quote")!.execute([quote.symbol], cli.context);
      const [{ result, options }] = cli.printed as [PrintedCliResult];
      const quoteText = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "text" }, options);
      const futures = settle !== null ? answer as FuturesContractTermsPayload : null;
      const report = await buildTickerReport({ symbol: quote.symbol, tickerFile: null, financials: createTestFinancials({ quote }),
        config, toBase: async (value) => value, futuresContract: futures });
      // JSON carries what ticker's JSON does; text prints the Settle line and Contract block ticker prints.
      expect((result.data as Array<{ futuresContract?: unknown }>)[0]!.futuresContract).toEqual(futures ?? undefined);
      const flat = (value: string) => value.replace(/ +/g, " ");
      for (const line of settle === null ? [] : [`Settle ${settle}`, "Contract GCZ26", "Tick 0.10 = $10.00", "First Notice 2026-11-30"]) {
        expect(flat(quoteText)).toContain(`\n${line}\n`);
        expect(flat(report)).toContain(`\n${line}\n`);
      }
      if (settle === null) {
        expect(quoteText).not.toContain("Settle");
        expect(report).not.toMatch(/Settle|Contract/);
      }
      // A stock is never looked up.
      expect(loads).toHaveBeenCalledTimes(quote.instrumentType === "EQUITY" ? 0 : 1);

      await act(async () => {
        await tui.render(
          <AppContext value={createStaticAppStore(createInitialState(config))}>
            <OverviewTab ticker={createTestTicker(quote.symbol, quote.name!, { assetCategory: quote.instrumentType })}
              financials={createTestFinancials({ quote: quote as Quote })} width={120} height={40} />
          </AppContext>,
          { width: 120, height: 40 },
        );
      });
      if (settle === null) {
        await settleFrame(tui.setup(), 10);
        expect(tui.frame()).not.toMatch(/Settle|Contract/);
        // The quote renders whether or not there are terms.
        expect(tui.frame()).toContain(quote.symbol === "AAPL" ? "$336.64" : "$4,216.30");
      } else {
        const frame = await tui.waitForFrameToContain(`Settle ${settle}`);
        expect(frame).toMatch(/Contract\s+GCZ26/);
        expect(frame).toMatch(/First Notice\s+2026-11-30/);
        expect(frame).toMatch(/Tick\s+0\.10 = \$10\.00/);
      }
    } finally {
      loads.mockRestore();
    }
  });
}

test("a short Overview keeps the most useful contract terms and the chart below them", async () => {
  const loads = spyOn(apiClient, "getCloudFuturesContract").mockResolvedValue(terms);
  try {
    await act(async () => {
      await tui.render(
        <AppContext value={createStaticAppStore(createInitialState(config))}>
          <OverviewTab ticker={createTestTicker("GC=F", "Gold Dec 26", { assetCategory: "FUTURE" })}
            financials={createTestFinancials({ quote: futuresQuote })} width={44} height={20} />
        </AppContext>,
        { width: 44, height: 20 },
      );
    });
    const frame = await tui.waitForFrameToContain("Contract ");
    // One column, two rows: the month and the contract size; the rest drop before anything is cut sideways.
    expect(frame).toMatch(/Contract\s+GCZ26/);
    expect(frame).toMatch(/Size\s+100 troy oz/);
    expect(frame).not.toMatch(/Point Value|Unit|Last Trade/);
  } finally {
    loads.mockRestore();
  }
});
