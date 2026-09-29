import { describe, expect, test } from "bun:test";
import type { IpoDeal, IpoSourceHealth } from "../../../api-client/ipo";
import {
  buildIpoColumns,
  calendarDate,
  DEFAULT_IPO_SORT,
  filterIpoDeals,
  formatIpoPrice,
  formatIpoReturn,
  formatIpoSize,
  ipoTableWidth,
  ipoTickerKey,
  marketColumnWidth,
  marketsBehind,
  marketsBehindText,
  MISSING,
  sortIpoDeals,
} from "./model";
import { ipoDeal } from "./test-fixture";

const ids = (deals: readonly IpoDeal[]) => deals.map((deal) => deal.id);

describe("IPO calendar tabs and search", () => {
  const deals = [
    ipoDeal({ id: "arm", symbol: "ARM" }),
    ipoDeal({ id: "catl", company: "Contemporary Amperex", companyLocal: "宁德时代", symbol: "3750", mic: "XHKG", exchange: "HKEX", venue: "HKEX", country: "HK", region: "apac" }),
    ipoDeal({ id: "kioxia", symbol: "285A", mic: "XTKS", exchange: "JPX", venue: "Tokyo", country: "JP", region: "apac", status: "listed" }),
    ipoDeal({ id: "csg", mic: "XAMS", exchange: "AMS", venue: "Amsterdam", country: "NL", region: "europe" }),
    ipoDeal({ id: "aramco", mic: "XSAU", exchange: null, venue: "Tadawul", country: "SA", region: "other" }),
  ];

  test("a region tab holds its own deals, and a deal outside the three only shows under All", () => {
    expect(ids(filterIpoDeals(deals, "all"))).toEqual(["arm", "catl", "kioxia", "csg", "aramco"]);
    expect(ids(filterIpoDeals(deals, "us"))).toEqual(["arm"]);
    expect(ids(filterIpoDeals(deals, "apac"))).toEqual(["catl", "kioxia"]);
    expect(ids(filterIpoDeals(deals, "europe"))).toEqual(["csg"]);
  });

  test("search reads the local-script name, the venue, the country by name and the status", () => {
    expect(ids(filterIpoDeals(deals, "all", "宁德"))).toEqual(["catl"]);
    expect(ids(filterIpoDeals(deals, "all", "tokyo"))).toEqual(["kioxia"]);
    expect(ids(filterIpoDeals(deals, "all", "Netherlands"))).toEqual(["csg"]);
    expect(ids(filterIpoDeals(deals, "all", " LISTED "))).toEqual(["kioxia"]);
    // The tab still applies under a search.
    expect(ids(filterIpoDeals(deals, "us", "tokyo"))).toEqual([]);
  });
});

describe("IPO calendar order", () => {
  const deals = [
    ipoDeal({ id: "withdrawn", status: "withdrawn", listingDate: "2026-09-20" }),
    ipoDeal({ id: "listed-old", status: "listed", listingDate: "2026-09-01", firstDay: { session: "2026-09-01", open: 11, close: 12, returnPct: 0.2 } }),
    ipoDeal({ id: "upcoming-later", listingDate: "2026-10-20" }),
    ipoDeal({ id: "filed", status: "filed", filedDate: "2026-09-15" }),
    ipoDeal({ id: "priced", status: "priced", listingDate: "2026-09-30" }),
    // Still book building: the subscription window stands in for the listing date.
    ipoDeal({ id: "upcoming-bookbuild", subscriptionOpen: "2026-10-01", subscriptionClose: "2026-10-03" }),
    ipoDeal({ id: "upcoming-undated" }),
    ipoDeal({ id: "listed-new", status: "listed", listingDate: "2026-09-25" }),
    // Priced with no listing date yet: its book dates it, not the foot of the board.
    ipoDeal({ id: "priced-undated", status: "priced", subscriptionOpen: "2026-09-26", subscriptionClose: "2026-09-26" }),
  ];

  test("upcoming deals come soonest first, then priced and listed most recent first, then filings, then stopped deals", () => {
    expect(ids(sortIpoDeals(deals, DEFAULT_IPO_SORT))).toEqual([
      "upcoming-bookbuild", "upcoming-later", "upcoming-undated",
      "priced", "priced-undated", "listed-new", "listed-old",
      "filed",
      "withdrawn",
    ]);
  });

  test("PRICE sorts across currencies in US dollars, at the rate the deal size was converted at", () => {
    const priced = [
      // ¥1,200 at 150 yen to the dollar is $8.
      ipoDeal({ id: "tokyo", currency: "JPY", offerPrice: 1200, offerSize: 150e9, offerSizeUsd: 1e9 }),
      ipoDeal({ id: "nasdaq", currency: "USD", offerPrice: 20, offerSize: 100e6, offerSizeUsd: 100e6 }),
      // 250p at $1.30 to the pound is $3.25.
      ipoDeal({ id: "london", currency: "GBX", priceLow: 240, priceHigh: 260, offerSize: 50_000e6, offerSizeUsd: 650e6 }),
      ipoDeal({ id: "unsized", currency: "USD", offerPrice: 99 }),
    ];
    expect(ids(sortIpoDeals(priced, { columnId: "price", direction: "desc" }))).toEqual(["nasdaq", "tokyo", "london", "unsized"]);
  });
});

describe("IPO calendar columns", () => {
  test("a narrowing pane drops SIZE, STATUS, PRICE, MKT, DATE, then TICKER, keeping COMPANY and RETURN", () => {
    const columnIds = (width: number) => buildIpoColumns(width).map((column) => column.id);
    const full = ["ticker", "company", "market", "date", "status", "price", "size", "return"];
    const fullWidth = ipoTableWidth(buildIpoColumns(1000));
    expect(columnIds(fullWidth)).toEqual(full);
    expect(columnIds(fullWidth - 1)).toEqual(["ticker", "company", "market", "date", "status", "price", "return"]);
    expect(columnIds(80)).toEqual(["ticker", "company", "market", "date", "price", "return"]);
    expect(columnIds(60)).toEqual(["ticker", "company", "market", "date", "return"]);
    expect(columnIds(20)).toEqual(["company", "return"]);
    // MKT is as wide as the longest venue on the board, so a wider one costs a column sooner.
    expect(marketColumnWidth([ipoDeal({ id: "a" }), ipoDeal({ id: "b", venue: "NYSE American" })])).toBe(13);
    expect(marketColumnWidth([ipoDeal({ id: "a" })])).toBe(6);
    expect(buildIpoColumns(fullWidth, 13).map((column) => column.id)).not.toContain("size");
    for (let width = 34; width <= 140; width += 1) {
      const columns = buildIpoColumns(width);
      expect(ipoTableWidth(columns)).toBeLessThanOrEqual(width);
      expect(columns.map((column) => column.id)).toEqual(expect.arrayContaining(["company", "return"]));
    }
  });
});

describe("IPO calendar cells", () => {
  test("PRICE shows the offer price once set, else the range, in the deal's own currency", () => {
    expect(formatIpoPrice(ipoDeal({ id: "a", priceLow: 18, priceHigh: 20 }))).toBe("$18-20");
    expect(formatIpoPrice(ipoDeal({ id: "b", priceLow: 18, priceHigh: 20, offerPrice: 21.5 }))).toBe("$21.50");
    expect(formatIpoPrice(ipoDeal({ id: "c", currency: "HKD", priceLow: 26.2, priceHigh: 28.5 }))).toBe("HK$26.20-28.50");
    expect(formatIpoPrice(ipoDeal({ id: "d", currency: "JPY", priceLow: 1200, priceHigh: 1400 }))).toBe("¥1,200-1,400");
    // London quotes in pence, never pounds.
    expect(formatIpoPrice(ipoDeal({ id: "e", currency: "GBX", priceLow: 240, priceHigh: 260 }))).toBe("240-260p");
    expect(formatIpoPrice(ipoDeal({ id: "f", currency: "CHF", offerPrice: 45 }))).toBe("CHF 45");
    expect(formatIpoPrice(ipoDeal({ id: "g", currency: "INR", priceLow: 159, priceHigh: 159 }))).toBe("₹159");
    expect(formatIpoPrice(ipoDeal({ id: "h" }))).toBe(MISSING);
  });

  test("TICKER and SIZE fit the longest values the live board has", () => {
    const width = (id: string) => buildIpoColumns(1000).find((column) => column.id === id)!.width;
    expect(formatIpoSize(218_818_383)).toBe("$218.82M");
    expect(formatIpoSize(218_818_383).length).toBeLessThanOrEqual(width("size"));
    expect("SWASTIKAIN".length).toBeLessThanOrEqual(width("ticker"));
  });

  test("RETURN reads the first-day fraction as a signed percent", () => {
    expect(formatIpoReturn(0.164)).toBe("+16.4%");
    expect(formatIpoReturn(-0.05)).toBe("-5.0%");
    expect(formatIpoReturn(-0.0004)).toBe("0.0%");
    expect(formatIpoReturn(null)).toBe(MISSING);
  });

  test("a row opens its ticker on its own venue, so a numeric code never opens a US listing", () => {
    expect(ipoTickerKey(ipoDeal({ id: "a", symbol: "0700", mic: "XHKG", exchange: "HKEX" }))).toBe("0700:XHKG");
    expect(ipoTickerKey(ipoDeal({ id: "b", symbol: "7203", mic: "XTKS", exchange: "JPX" }))).toBe("7203:JPX");
    expect(ipoTickerKey(ipoDeal({ id: "c", symbol: "ARM" }))).toBe("ARM:XNAS");
    // No exchange code, no key: `GDL:XDUB` would reach only the US GDL.
    expect(ipoTickerKey(ipoDeal({ id: "d", symbol: "GDL", mic: "XDUB", exchange: null }))).toBeNull();
    expect(ipoTickerKey(ipoDeal({ id: "e", symbol: null }))).toBeNull();
  });
});

describe("markets behind", () => {
  const source = (id: string, mics: string[], ok: boolean): IpoSourceHealth => ({ id, mics, ok, asOf: null });

  test("a market is behind only when no source covering it answered, and only on its own tab", () => {
    const sources = [
      source("nasdaq", ["XNAS", "XNYS", "XASE"], true),
      source("nse", ["XNSE"], false),
      source("euronext", ["XPAR", "XAMS"], false),
      // A cross-check failing behind a working exchange feed leaves nothing behind.
      source("cross-check", ["XNAS", "XHKG"], false),
      source("hkex", ["XHKG"], true),
    ];
    expect(marketsBehind(sources, "all")).toEqual(["India", "France", "Netherlands"]);
    expect(marketsBehind(sources, "apac")).toEqual(["India"]);
    expect(marketsBehind(sources, "us")).toEqual([]);
    expect(marketsBehindText(["India"])).toBe("India not updated");
    expect(marketsBehindText(["UK", "Switzerland", "Germany"])).toBe("UK, Switzerland and Germany not updated");
    expect(marketsBehindText(["UK", "France", "Italy", "Norway"])).toBe("UK, France and 2 more not updated");
    expect(marketsBehindText([])).toBeNull();
  });
});

describe("calendarDate", () => {
  test("a book with no listing date yet stands on its closing day", () => {
    const deal = ipoDeal({ id: "book", status: "upcoming", listingDate: null, subscriptionOpen: "2026-10-01", subscriptionClose: "2026-10-03" });
    expect(calendarDate(deal)).toBe("2026-10-03");
    expect(calendarDate({ ...deal, listingDate: "2026-10-08" })).toBe("2026-10-08");
  });
});
