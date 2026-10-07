import { describe, expect, test } from "bun:test";
import type { SecFilingItem } from "../../../types/data-provider";
import { createSecFilingSearchProvider, parseFilingLookup, selectLookupFilings } from "./command-bar-search";

function filing(accessionNumber: string, form: string, filingDate: string): SecFilingItem {
  return {
    accessionNumber,
    form,
    filingDate: new Date(`${filingDate}T00:00:00Z`),
    cik: "0000320193",
    companyName: "Apple Inc.",
    filingUrl: `https://www.sec.gov/Archives/edgar/data/320193/${accessionNumber}-index.htm`,
  };
}

// Apple's filings as Gloom Cloud listed them on 2026-10-05, a few of the newest
// 200: ownership and sale notices first, the reports further down.
const appleFilings = [
  filing("0001958244-26-000636", "144", "2026-10-02"),
  filing("0001140361-26-038307", "4", "2026-10-01"),
  filing("0000320193-26-000020", "10-Q", "2026-07-31"),
  { ...filing("0000320193-26-000018", "8-K", "2026-07-30"), items: "2.02,9.01" },
  filing("0001308179-26-000008", "DEF 14A", "2026-01-08"),
  filing("0000320193-25-000079", "10-K", "2025-10-31"),
  filing("0000320193-24-000123", "10-K", "2024-11-01"),
];

describe("parseFilingLookup", () => {
  test("reads one ticker with a form or the word filings, in either order", () => {
    expect(parseFilingLookup("AAPL 10-K")).toEqual({ ticker: "AAPL", form: "10-K" });
    expect(parseFilingLookup("10q msft")).toEqual({ ticker: "MSFT", form: "10-Q" });
    expect(parseFilingLookup("brk.b def 14a")).toEqual({ ticker: "BRK.B", form: "DEF 14A" });
    expect(parseFilingLookup("nvda filings")).toEqual({ ticker: "NVDA", form: null });
  });

  test("leaves bare tickers, sentences and two issuers alone", () => {
    expect(parseFilingLookup("AAPL")).toBeNull();
    expect(parseFilingLookup("10-K")).toBeNull();
    expect(parseFilingLookup("AAPL MSFT 10-K")).toBeNull();
    expect(parseFilingLookup("apple quarterly earnings 10-Q")).toBeNull();
    expect(parseFilingLookup("AAPL 10-K 10-Q")).toBeNull();
  });
});

describe("selectLookupFilings", () => {
  test("a form keeps its amendments, newest first", () => {
    const amended = filing("0000000000-26-000001", "10-K/A", "2026-01-15");
    expect(selectLookupFilings([...appleFilings, amended], { ticker: "AAPL", form: "10-K" }).map((item) => item.accessionNumber))
      .toEqual([amended.accessionNumber, "0000320193-25-000079", "0000320193-24-000123"]);
  });

  test("without a form, reports only: no ownership or sale notices", () => {
    expect(selectLookupFilings(appleFilings, { ticker: "AAPL", form: null }).map((item) => item.form))
      .toEqual(["10-Q", "8-K", "DEF 14A", "10-K"]);
  });
});

describe("the SEC filing lookup provider", () => {
  const signal = new AbortController().signal;
  const now = () => Date.parse("2026-10-05T12:00:00Z");

  test("lists the issuer's recent matching filings and opens the SEC pane on its ticker", async () => {
    const requests: unknown[] = [];
    const opened: unknown[] = [];
    const provider = createSecFilingSearchProvider(
      { createPaneFromTemplate: (templateId, options) => { opened.push([templateId, options]); } },
      {
        getCoordinator: () => ({
          loadSecFilings: async (request) => {
            requests.push(request);
            return { data: appleFilings, lastGoodData: null } as never;
          },
        }),
        now,
      },
    );

    const rows = await provider.provide("aapl 10-k", { activeTicker: null, activeCollectionId: null }, signal);
    expect(requests[0]).toEqual({ instrument: { symbol: "AAPL" }, count: 200 });
    expect(rows.map((row) => [row.badge, row.label, row.right])).toEqual([
      ["10-K", "Annual Report", "Oct 2025"],
      ["10-K", "Annual Report", "Nov 2024"],
    ]);
    const eightK = await provider.provide("AAPL 8-K", { activeTicker: null, activeCollectionId: null }, signal);
    expect(eightK.map((row) => [row.label, row.right])).toEqual([["Current Report · Items 2.02,9.01", "Jul 30"]]);
    await rows[0]!.execute();
    expect(opened).toEqual([["sec-pane", { symbol: "AAPL" }]]);
  });

  test("filings restored from the on-disk cache, with string dates, still list", async () => {
    const restored = JSON.parse(JSON.stringify(appleFilings)) as SecFilingItem[];
    const provider = createSecFilingSearchProvider(
      { createPaneFromTemplate: () => {} },
      { getCoordinator: () => ({ loadSecFilings: async () => ({ data: restored, lastGoodData: null }) as never }), now },
    );
    const rows = await provider.provide("AAPL 10-K", { activeTicker: null, activeCollectionId: null }, signal);
    expect(rows.map((row) => row.right)).toEqual(["Oct 2025", "Nov 2024"]);
  });

  test("an unknown ticker or a failed request adds no rows", async () => {
    const provider = createSecFilingSearchProvider(
      { createPaneFromTemplate: () => {} },
      { getCoordinator: () => ({ loadSecFilings: async () => { throw new Error("Unknown ticker ZZZZ"); } }), now },
    );
    expect(await provider.provide("ZZZZ 10-K", { activeTicker: null, activeCollectionId: null }, signal)).toEqual([]);
  });
});
