import { expect, test } from "bun:test";
import type { InstrumentSearchResult } from "../../types/instrument";
import { createTestTicker } from "../../test-support/ticker";
import fixture from "./fixtures/symbol-answers-2026-11-06.json";
import { buildTickerSearchCandidates } from ".";

/** A fixture row: symbol, name, exchange, type, currency, primary exchange, home line, popularity, delisting status. */
type Row = [string, string, string, string, string | null, string | null, 0 | 1, number | null, string | null];

/** Gloom Cloud's batched search answer for `query` on the fixture's date, as the app reads it. */
function answer(query: keyof typeof fixture.answers): InstrumentSearchResult[] {
  return (fixture.answers[query] as Row[]).map(([symbol, name, exchange, type, currency, primaryExchange, home, popularity, delisting]) => ({
    providerId: "gloomberb-cloud", symbol, name, exchange, type,
    ...currency ? { currency } : {},
    ...primaryExchange ? { primaryExchange } : {},
    ...home ? { homeListing: true } : {},
    ...popularity != null ? { popularity } : {},
    ...delisting ? { delisting: { status: delisting as "delisted" } } : {},
  }));
}

/** The row the bar and the shipped listings lead with for the symbol typed, as `name | exchange`. */
function lead(query: keyof typeof fixture.answers, rows = answer(query), tickers = new Map()): string {
  const [first] = buildTickerSearchCandidates({ query, tickers, providerResults: rows, totalLimit: 30 });
  return `${first?.result?.name} | ${first?.result?.exchange || "-"}`;
}

test.each([
  // A company whose name starts with the letters: AXP Energy, CAT Strategic Metals.
  ["AXP", "American Express Company | NYSE"],
  ["CAT", "Caterpillar, Inc. | NYSE"],
  // A Toronto line named only by its symbol.
  ["JNJ", "Johnson & Johnson | NYSE"],
  ["HD", "The Home Depot, Inc. | NYSE"],
  ["BX", "Blackstone Inc. | NYSE"],
  ["MRK", "Merck & Company, Inc. | NYSE"],
  // The company with a US listing leads, as `quote` reads the symbol, and its US line leads its others.
  ["AAL", "American Airlines Group, Inc. | NASDAQ"],
  ["AI", "C3.ai, Inc. | NYSE"],
  ["MC", "Moelis & Company | NYSE"],
  ["OR", "OR Royalties Inc. | NYSE"],
  ["RR", "Richtech Robotics Inc. | NASDAQ"],
  ["G", "Genpact Limited | NYSE"],
  ["NG", "Novagold Resources Inc. | AMEX"],
  ["AV", "Corgi Aerospace & Commercial Aviation ETF | BATS"],
  ["CAP", "Capitol Investment Corp. V | NYSE"],
  ["BABA", "Alibaba Group Holding Limited ADR | NYSE"],
  ["SAN", "Banco Santander, S.A. ADR | NYSE"],
  ["NN", "NextNav Inc. | NASDAQ"],
  ["UCB", "United Community Banks, Inc. | NYSE"],
  ["ASM", "Avino Silver & Gold Mines Ltd. | AMEX"],
  ["GLE", "Global Engine Group Holding Limited | NASDAQ"],
  ["AIR", "AAR Corp. | NYSE"],
  ["DG", "Dollar General Corporation | NYSE"],
  ["DTE", "DTE Energy Company | NYSE"],
  ["RACE", "Ferrari N.V. | NYSE"],
  ["SHEL", "Shell PLC ADR | NYSE"],
  ["BRK.B", "Berkshire Hathaway Inc. | NYSE"],
  // A US line that no longer trades is not one: the company with a home line leads, ahead of an old line with
  // no name or exchange.
  ["CS", "AXA SA | EPA"],
  ["SAF", "Safran SA | EPA"],
  ["BMW", "Bayerische Motoren Werke AG | XETRA"],
  ["GLEN", "Glencore plc | LSE"],
  ["ISP", "Intesa Sanpaolo S.p.A. | BIT"],
  ["BATS", "British American Tobacco plc | LSE"],
  ["ADS", "adidas AG | XETRA"],
  ["MBG", "Mercedes-Benz Group AG | XETRA"],
  ["AC", "Accor SA | EPA"],
  ["BT.A", "BT Group plc | LSE"],
  ["HM.B", "Hennes & Mauritz AB | SFB"],
  ["AIY", "iFAST Corporation Ltd. | SGX"],
  // A code with digits on SGX is its SGX line, not another company's Frankfurt line under it. A lettered symbol
  // keeps the company whose lines carry it (EQR's NYSE line became VMRK) ahead of another company's.
  ["EQR", "Vivmark Residential | FWB2"],
  ["5E2", "Seatrium Ltd. | SGX"],
  ["D01", "DFI Retail Group Holdings Limited | SGX"],
  ["D05", "DBS Group Holdings Ltd. | SGX"],
  // A code of digits keeps search's order of markets, whichever line is marked a home: BYD's is in Shenzhen.
  ["0700", "Tencent Holdings Limited | HKEX"],
  ["600519", "Kweichow Moutai Co., Ltd. | SSE"],
  ["7203", "Toyota Motor Corporation | JPX"],
  ["1211", "BYD Company Limited | HKEX"],
  ["2382", "Sunny Optical Technology (Group) Company Limited | HKEX"],
] as const)("%s leads with %s", (query, expected) => {
  expect(lead(query)).toBe(expected);
});

test("a saved listing of the symbol keeps the lead, and a symbol only a nameless line lists still lists it", () => {
  const saved = createTestTicker("AXP", "AXP Energy Limited", { exchange: "ASX", currency: "AUD" });
  expect(lead("AXP", answer("AXP"), new Map([["AXP", saved]]))).toBe("AXP Energy Limited | ASX");
  expect(lead("ISP", answer("ISP").filter((row) => !row.exchange))).toBe("ISP | -");
});

test("a ticker in small letters is the ticker; a word written as a name gives a US line no head start", () => {
  expect(lead("aal" as "AAL", answer("AAL"))).toBe("American Airlines Group, Inc. | NASDAQ");
  // Written as a name, the service's order of companies under the symbol stands.
  expect(lead("Aal" as "AAL", answer("AAL"))).toBe("Anglo American plc | LSE");
});

test("a line with no name or venue of its own follows the companies even where search lists it first", () => {
  // No home line to go by, as for a code of digits: the nameless line and a Toronto line named by its symbol.
  const unmarked = (rows: InstrumentSearchResult[]) => rows.map(({ homeListing: _home, ...row }) => row);
  const isp = unmarked(answer("ISP"));
  expect(lead("ISP", [...isp.filter((row) => !row.exchange), ...isp.filter((row) => row.exchange)])).toBe("Intesa Sanpaolo S.p.A. | BIT");
  const sunny = answer("2382");
  const named = { ...sunny[0]!, name: "2382", exchange: "TSX", primaryExchange: "TSX" };
  expect(lead("2382", [named, ...sunny])).toBe("Sunny Optical Technology (Group) Company Limited | HKEX");
});
