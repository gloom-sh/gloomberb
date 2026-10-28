import { expect, spyOn, test } from "bun:test";
import { createDefaultConfig } from "../../types/config";
import type { Quote } from "../../types/financials";
import type { MarketContext } from "../types";
import { createTestDataProvider, createTestQuote } from "../../test-support/data-provider";
import { ipoDeal } from "../../plugins/builtin/ipo-calendar/test-fixture";
import type { TickerIpo } from "../../plugins/builtin/ipo-calendar/listing-ipo";
import { ticker } from "./ticker";

const config = createDefaultConfig("/tmp/gloom-ticker-ipo-unused");

/** HawkEye 360 as the IPO calendar lists it: priced at $26, first traded on the NYSE on 7 May 2026, a 180-day lock-up from its prospectus. */
const HAWK: TickerIpo = {
  deal: ipoDeal({
    id: "hawk", company: "HawkEye 360, Inc.", symbol: "HAWK", mic: "XNYS", exchange: "NYSE", venue: "NYSE",
    listingDate: "2026-05-07", dateKind: "actual", status: "listed", offerPrice: 26,
    firstDay: { session: "2026-05-07", open: 33.8, close: 34, returnPct: 0.3077 },
    lockup: { endsOn: "2026-11-02", days: 180, basis: "prospectus", prospectusDate: "2026-05-06", prospectusUrl: null },
  }),
  news: [{ title: "HawkEye 360 Confirms Early Lock-up Release for September 2nd", source: "PR Newswire",
    publishedAt: "2026-08-31T11:41:00.000Z", url: "https://example.com/hawk" }],
};

async function report(quote: Partial<Quote>, { json = false } = {}) {
  let data: any;
  let text = "";
  const asked: { symbol: string; exchange?: string | null }[] = [];
  const log = spyOn(console, "log").mockImplementation((line?: unknown) => { text += `${String(line)}\n`; });
  try {
    await ticker("HAWK", {
      listingIpo: async (listing) => { asked.push(listing); return HAWK; },
      initMarketData: async () => ({
        config, dataDir: "/tmp/gloom-ticker-ipo-unused",
        store: { loadTicker: async () => null }, persistence: { close: () => {} },
        dataProvider: {
          ...createTestDataProvider({ getTickerFinancials: async () => ({
            quote: createTestQuote({ symbol: "HAWK", price: 13.27, listingExchangeName: "NYSE", ...quote }),
            annualStatements: [], quarterlyStatements: [], priceHistory: [],
          }) }),
          getNews: async () => [],
          getSecFilings: async () => [],
        },
      }) as unknown as MarketContext,
      fail: (message) => { throw new Error(message); },
      ...json ? { printResult: (result: { data?: unknown }) => { data = result.data; } } : {},
    });
  } finally {
    log.mockRestore();
  }
  return { data, asked, text: text.replace(/\u001b\[[0-9;]*m/g, "") };
}

test("a stock that listed in the last year shows its IPO, the move since and the lock-up estimate", async () => {
  // A common stock, whatever word the source types it with.
  for (const instrumentType of ["EQUITY", "Common Stock", undefined]) {
    const { text, asked } = await report({ instrumentType });
    expect(asked).toEqual([{ symbol: "HAWK", exchange: "NYSE" }]);
    const section = text.slice(text.indexOf("\nIPO\n"));
    expect(section).toContain("IPO date   2026-05-07 on NYSE");
    expect(section).toContain("Offer      $26");
    expect(section).toContain("Since IPO  -49.0% ($26 to $13.27)");
    expect(section).toContain("Lockup     ends ~2026-11-02 (estimate)");
    expect(section).toContain("Lock-up news 2026-08-31: HawkEye 360 Confirms Early Lock-up Release for September 2nd (PR Newswire)");
  }
  const { data } = await report({ instrumentType: "EQUITY" }, { json: true });
  expect(data.ipo).toMatchObject({ symbol: "HAWK", offerPrice: 26, lockup: { endsOn: "2026-11-02" }, lockupNews: HAWK.news });
});

test("a fund is never read for an IPO", async () => {
  const { text, asked } = await report({ instrumentType: "ETF" });
  expect(asked).toEqual([]);
  expect(text).not.toContain("\nIPO\n");
});
