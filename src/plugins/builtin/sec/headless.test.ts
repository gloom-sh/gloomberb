import { describe, expect, test } from "bun:test";
import type { SecFilingItem } from "../../../types/data-provider";
import type { HeadlessBundleSection, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { ETF_FILING_FORMS, SEC_FILING_FETCH_LIMIT } from "./forms";
import { createFundHeadless, createSecHeadless, fundFilingsEmpty } from "./headless";
import type { FundFactsPayload } from "../../../api-client/fund-facts";
import { FUND_FACTS_UNAVAILABLE } from "./fund-facts";
import { buildSecFilingRows, getFilingColumnText, secAcceptanceTimestamp } from "./model";
import { createTestHeadlessContext } from "../../../test-support/headless";

const filings: SecFilingItem[] = [
  {
    accessionNumber: "0000320193-26-000100",
    form: "8-K",
    filingDate: new Date("2026-08-25T00:00:00.000Z"),
    primaryDocDescription: "8-K Results of Operations",
    items: "2.02,9.01",
    cik: "0000320193",
    filingUrl: "https://www.sec.gov/filing/one",
  },
  {
    accessionNumber: "0000320193-26-000099",
    form: "10-Q",
    filingDate: new Date("2026-08-20T00:00:00.000Z"),
    cik: "0000320193",
    filingUrl: "https://www.sec.gov/filing/two",
  },
];

function args(limit: number): HeadlessPaneLoadArgs {
  return {
    rawArgument: "AAPL",
    argument: "AAPL",
    symbols: ["AAPL"],
    options: { limit },
  };
}

describe("SEC headless model", () => {
  test("projects filing rows and honors the page limit", async () => {
    const requestedLimits: number[] = [];
    const headless = createSecHeadless({
      loadFilings: async (_symbol, limit) => {
        requestedLimits.push(limit);
        return filings;
      },
    });

    const first = await headless.load(args(1), createTestHeadlessContext());
    expect(first.rows).toEqual([{
      filedAt: "2026-08-25T00:00:00.000Z",
      acceptedAt: null,
      acceptedAtRaw: null,
      acceptanceReported: null,
      form: "8-K",
      filing: "Results of Operations | Current Report",
      items: "2.02,9.01",
      accessionNumber: "0000320193-26-000100",
      primaryDocument: null,
      cik: "0000320193",
      companyName: null,
      url: "https://www.sec.gov/filing/one",
    }]);

    const both = await headless.load(args(2), createTestHeadlessContext());
    expect(both.rows).toHaveLength(2);
    // A first read asks for a few hundred, past the pricing supplements a bank files in runs.
    expect(requestedLimits).toEqual([200, 200]);
  });

  // WFC as the service lists it: 192 of its last 200 filings are note supplements, its results 8-K behind them.
  const supplement = (index: number, form = "424B2", description = "PRICING SUPPLEMENT NO. 1"): SecFilingItem => ({
    ...filings[1]!, form, primaryDocDescription: description, accessionNumber: `0001839882-26-${String(index).padStart(6, "0")}`,
  });
  const bank = [
    ...Array.from({ length: 150 }, (_, index) => supplement(index)),
    supplement(900, "FWP", "FREE WRITING PROSPECTUS"),
    filings[0]!,
    // Among the bank's notes, a plain 424B3 is a note's term sheet too.
    supplement(901, "424B3", "PROSPECTUS"),
    ...Array.from({ length: 300 }, (_, index) => supplement(1000 + index)),
    filings[1]!,
  ];

  test("leaves a bank's pricing supplements out, says how many, and lists them with --all", async () => {
    const requested: number[] = [];
    const headless = createSecHeadless({ loadFilings: async (_symbol, limit) => {
      requested.push(limit);
      return bank.slice(0, limit);
    } });

    const hidden = await headless.load(args(3), createTestHeadlessContext());
    expect(hidden.rows.map((row) => row.accessionNumber)).toEqual([filings[0]!.accessionNumber, filings[1]!.accessionNumber]);
    expect(hidden.notes).toEqual(["452 pricing supplements hidden, --all to show"]);
    expect(hidden.metadata?.pricingSupplementsHidden).toBe(452);
    // The first read (200) left the list short, so a larger one followed.
    expect(requested).toEqual([200, 1_000]);

    const all = await headless.load({ ...args(3), options: { limit: 3, all: true } }, createTestHeadlessContext());
    expect(all.rows.map((row) => row.form)).toEqual(["424B2", "424B2", "424B2"]);
    expect(all.notes).toBeUndefined();
  });

  test("--form keeps that form and its amendments from every filing listed, as filings --form does", async () => {
    const requested: number[] = [];
    const amended = { ...filings[0]!, form: "8-K/A", accessionNumber: "0000320193-26-000001" };
    const headless = createSecHeadless({ loadFilings: async (_symbol, limit) => {
      requested.push(limit);
      return [...bank, amended];
    } });
    const eightK = await headless.load({ ...args(5), options: { limit: 5, form: "8-k" } }, createTestHeadlessContext());
    expect(requested).toEqual([SEC_FILING_FETCH_LIMIT]);
    expect(eightK.rows.map((row) => row.form)).toEqual(["8-K", "8-K/A"]);
    expect(eightK.notes).toBeUndefined();
    // A supplement named by its form is listed.
    const named = await headless.load({ ...args(2), options: { limit: 2, form: "FWP" } }, createTestHeadlessContext());
    expect(named.rows.map((row) => row.form)).toEqual(["FWP"]);
    const none = await headless.load({ ...args(2), options: { limit: 2, form: "10-K" } }, createTestHeadlessContext());
    expect(none.rows).toEqual([]);
    expect(none.empty).toBe("No 10-K filings found for AAPL.");
  });
});

test.each([
  ["144", "FORM 144", "Notice of proposed sale of securities"],
  ["144/A", "144/A", "Notice of proposed sale of securities (Amended)"],
  ["4", "FORM 4 — Insider Transaction", "Insider Transaction"],
  ["4", "4 - Insider Transaction", "Insider Transaction"],
  ["8-K", "FORM 8-K – Results of Operations", "Results of Operations | Current Report"],
  ["S-4", "S-4: Merger terms", "Merger terms | Business Combination or Exchange Offer Registration"],
  ["4", "4/A amendment document", "4/A amendment document | Insider Transaction"],
])("FILING describes %s without repeating its FORM column (%s)", (form, description, expected) => {
  const entry = { ...filings[0]!, form, primaryDocDescription: description };
  expect(getFilingColumnText(entry)).toBe(expected);
  expect(buildSecFilingRows([entry])[0]).toMatchObject({ form, filing: expected });
});

test("ticker reuse preserves the actual filing issuer rather than the requested ticker's former company", async () => {
  const headless = createSecHeadless({ loadFilings: async () => [{
    ...filings[0]!, cik: "0001826011", companyName: "Banzai International, Inc."
  }] });
  const result = await headless.load({ ...args(1), argument: "PARA", symbols: ["PARA"] }, createTestHeadlessContext());
  expect(result.rows[0]).toMatchObject({ cik: "0001826011", companyName: "Banzai International, Inc." });
  expect(result.metadata?.issuers).toEqual([{ cik: "0001826011", companyName: "Banzai International, Inc." }]);
});

test("accepted timestamps survive persisted JSON rows and invalid cached values remain unknown", () => {
  const filing = { ...filings[0]!, acceptedAt: new Date("2025-03-20T20:10:11.000Z") };
  const restored = JSON.parse(JSON.stringify(filing)) as SecFilingItem;
  expect(secAcceptanceTimestamp(restored.acceptedAt)).toBe("2025-03-20T20:10:11.000Z");
  expect(buildSecFilingRows([restored])[0]?.acceptedAt).toBe("2025-03-20T20:10:11.000Z");
  const compact = { ...restored, acceptedAt: undefined, acceptedAtRaw: "20250320161011" };
  expect(buildSecFilingRows([compact])[0]).toMatchObject({ acceptedAt: null, acceptedAtRaw: "20250320161011", acceptanceReported: "20250320161011 (timezone unspecified)" });
  expect(secAcceptanceTimestamp("2025-03-20T16:10:11")).toBeNull();
  const naive = JSON.parse(JSON.stringify({ ...filing, acceptedAt: "2025-03-20T16:10:11" })) as SecFilingItem;
  expect(buildSecFilingRows([naive])[0]).toMatchObject({ acceptedAt: null, acceptanceReported: "2025-03-20T16:10:11 (timezone unspecified)" });
  expect(secAcceptanceTimestamp("invalid")).toBeNull();
  expect(secAcceptanceTimestamp(undefined)).toBeNull();
});

const SPY_FACTS: FundFactsPayload = {
  ticker: "SPY", covered: true, name: "SPDR S&P 500 ETF Trust", structure: "registered",
  expenseRatio: { value: 0.0945, asOf: "2026-10-15", source: "State Street", kind: "gross", url: "https://www.ssga.com/us/en/intermediary/etfs/spy" },
  nav: { value: 702.31, asOf: "2026-10-15", source: "State Street", url: "https://www.ssga.com/us/en/intermediary/etfs/spy" },
  closingPrice: { value: 702.4, asOf: "2026-10-15", source: "State Street" },
  premiumDiscount: { value: 0.013, asOf: "2026-10-15", source: "State Street", basis: "published" },
  netAssets: { value: 712_340_000_000, asOf: "2026-10-15", source: "State Street", scope: "fund" },
  sponsor: { value: "State Street Global Advisors", asOf: null, source: "State Street" },
  inception: { value: "1993-01-22", asOf: null, source: "State Street" },
  index: null, stale: false, fetchedAt: "2026-10-16T01:00:00.000Z",
};

const uncovered = (ticker: string, reason: string, structure: FundFactsPayload["structure"] = "trust"): FundFactsPayload => ({
  ticker, covered: false, reason, name: null, structure, expenseRatio: null, nav: null, closingPrice: null, premiumDiscount: null,
  netAssets: null, sponsor: null, inception: null, index: null, stale: false, fetchedAt: null,
});

/** A rows section's empty text; an entries section has none. */
const emptyOf = (section: HeadlessBundleSection | undefined) => section && !section.entries ? section.empty : undefined;

const fundArgs = (symbol: string): HeadlessPaneLoadArgs => ({ rawArgument: symbol, argument: symbol, symbols: [symbol], options: { limit: 50 } });

test("the fund view filters every issuer filing it loaded, amendments included, and says when that list was capped", async () => {
  const fund = (form: string, index: number): SecFilingItem => ({ ...filings[1]!, form, accessionNumber: `0000884394-26-${String(index).padStart(6, "0")}` });
  const issuerFilings = [fund("8-K", 1), fund("N-CSR/A", 2), fund("SC 13G", 3), fund("485BPOS", 4), fund("NPORT-P", 5)];
  const requested: number[] = [];
  const headless = createFundHeadless({
    loadFacts: async () => SPY_FACTS,
    loadFilings: async (_symbol, limit) => {
      requested.push(limit);
      return issuerFilings;
    },
  });

  const result = await headless.load(args(2), createTestHeadlessContext());
  expect(requested).toEqual([SEC_FILING_FETCH_LIMIT]);
  expect(result.sections[1]!.rows!.map((row) => row.form)).toEqual(["N-CSR/A", "485BPOS"]);
  expect(result.complete).toBe(true);
  expect(result.metadata).toMatchObject({ forms: [...ETF_FILING_FORMS], searchedFilings: issuerFilings.length });

  issuerFilings.push(...Array.from({ length: SEC_FILING_FETCH_LIMIT - issuerFilings.length }, (_, index) => fund("4", 100 + index)));
  expect((await headless.load(args(2), createTestHeadlessContext())).complete).toBe(false);
});

test("ETF leads with the fund's facts, each figure dated and credited, then its fund filings", async () => {
  const headless = createFundHeadless({
    loadFacts: async () => SPY_FACTS,
    loadFilings: async () => [{ ...filings[1]!, form: "485BPOS" }, { ...filings[1]!, form: "8-K" }],
  });
  const result = await headless.load(fundArgs("SPY"), createTestHeadlessContext());
  const [facts, filed] = result.sections;
  expect(facts!.title).toBe("Fund facts");
  expect(Object.fromEntries(facts!.entries!.map((entry) => [entry.key, entry.formatted]))).toMatchObject({
    expenseRatioPercent: "0.0945% gross · 2026-10-15 · State Street",
    nav: "$702.31 · 2026-10-15 · State Street",
    premiumDiscountPercent: "+0.01% · 2026-10-15 · State Street",
    netAssets: "$712.34B · 2026-10-15 · all share classes · State Street",
    sponsor: "State Street Global Advisors",
    inception: "1993-01-22",
  });
  // JSON keeps each raw number.
  expect(facts!.entries!.find((entry) => entry.key === "netAssets")!.value).toBe(712_340_000_000);
  expect(filed!.rows!.map((row) => row.form)).toEqual(["485BPOS"]);
  // The report's source is the facts' publisher, named the same way for every fund.
  expect(result.freshness).toMatchObject({ source: "State Street", publisher: "State Street", asOf: "2026-10-15" });
  expect(result.complete).toBe(true);
});

test("a computed premium says it is the closing price against the NAV and who computed it", async () => {
  const computed: FundFactsPayload = { ...SPY_FACTS, premiumDiscount: { value: -0.0123, asOf: "2026-10-15", source: "Gloom Cloud", basis: "computed" } };
  const result = await createFundHeadless({ loadFacts: async () => computed, loadFilings: async () => [] }).load(fundArgs("SPY"), createTestHeadlessContext());
  expect(result.sections[0]!.entries!.find((entry) => entry.key === "premiumDiscountPercent")!.formatted)
    .toBe("-0.01% · 2026-10-15 · closing price vs NAV · Gloom Cloud");
  expect(result.freshness).toMatchObject({ source: "State Street", publisher: "State Street" });
});

test("month-end net assets say so, and a stale NAV adds the note saying since when", async () => {
  const vanguard: FundFactsPayload = {
    ...SPY_FACTS, ticker: "VOO", stale: true,
    nav: { value: 701.68, asOf: "2026-10-01", source: "Vanguard" },
    netAssets: { value: 1e12, asOf: "2026-09-30", source: "Vanguard", scope: "share-class", period: "month-end" },
  };
  const result = await createFundHeadless({ loadFacts: async () => vanguard, loadFilings: async () => [] }).load(fundArgs("VOO"), createTestHeadlessContext());
  expect(result.sections[0]!.entries!.find((entry) => entry.key === "netAssets")!.formatted).toBe("$1T · 2026-09-30 month-end · Vanguard");
  expect(result.notes).toEqual(["VOO's newest NAV is from 2026-10-01; its sponsor has not published one since."]);
});

test("a grantor trust without facts says why once, and its filings line says where its filings are", async () => {
  const trust = (form: string): SecFilingItem => ({ ...filings[1]!, form });
  let issuerFilings = [trust("10-Q"), trust("8-K"), trust("424I")];
  let facts = uncovered("USO", "USO files with the SEC as a trust or pool, not as an open-end fund; its sponsor's daily figures are not collected yet.");
  const headless = createFundHeadless({ loadFacts: async () => facts, loadFilings: async () => issuerFilings });
  const load = () => headless.load(fundArgs("USO"), createTestHeadlessContext());

  let [factsSection, filed] = (await load()).sections;
  expect(factsSection).toMatchObject({ rows: [], empty: "USO files with the SEC as a trust or pool, not as an open-end fund; its sponsor's daily figures are not collected yet." });
  expect(emptyOf(filed)).toBe("USO files none of the fund forms ETF lists (prospectus, shareholder reports, N-CEN, N-PORT). Its other filings: fn SEC USO.");
  // A capped page may hide older fund forms.
  issuerFilings = Array.from({ length: SEC_FILING_FETCH_LIMIT }, () => trust("10-Q"));
  expect(emptyOf((await load()).sections[1])).toStartWith(`None of USO's latest ${SEC_FILING_FETCH_LIMIT} SEC filings is a fund form ETF lists`);
  // No filings at all: the facts line is the one that points to SEC.
  issuerFilings = [];
  facts = uncovered("USO", "USO's sponsor does not publish fund data Gloom collects yet.", "registered");
  [factsSection, filed] = (await load()).sections;
  expect(emptyOf(factsSection)).toBe("USO's sponsor does not publish fund data Gloom collects yet. Its SEC filings: fn SEC USO.");
  expect(emptyOf(filed)).toBe("No SEC filings found for USO.");
});

test("either half can fail without taking the other with it", async () => {
  const signedOut = createFundHeadless({ loadFacts: async () => SPY_FACTS, loadFilings: async () => { throw new Error("Sign in to Gloom Cloud to load SEC filings."); } });
  const result = await signedOut.load(fundArgs("SPY"), createTestHeadlessContext());
  expect(result.sections[0]!.entries!.length).toBeGreaterThan(0);
  expect(emptyOf(result.sections[1])).toBe("Fund filings unavailable: Sign in to Gloom Cloud to load SEC filings.");
  expect(result.errors).toEqual(["Fund filings: Sign in to Gloom Cloud to load SEC filings."]);
  expect(result.complete).toBe(false);

  const noFacts = createFundHeadless({ loadFacts: async () => { throw new Error("offline"); }, loadFilings: async () => [{ ...filings[1]!, form: "N-CSR" }] });
  const partial = await noFacts.load(fundArgs("SPY"), createTestHeadlessContext());
  expect(emptyOf(partial.sections[0])).toBe("Fund facts unavailable: offline");
  expect(partial.errors).toEqual(["Fund facts unavailable: offline"]);
  expect(partial.sections[1]!.rows!.length).toBe(1);

  // Before the server serves fund facts, the report says so once.
  const notYet = createFundHeadless({ loadFacts: async () => { throw new Error(FUND_FACTS_UNAVAILABLE); }, loadFilings: async () => [] });
  expect(emptyOf((await notYet.load(fundArgs("SPY"), createTestHeadlessContext())).sections[0])).toBe("Fund facts are not available on this server yet.");

  const neither = createFundHeadless({ loadFacts: async () => { throw new Error("offline"); }, loadFilings: async () => { throw new Error("down"); } });
  await expect(neither.load(fundArgs("SPY"), createTestHeadlessContext())).rejects.toThrow("down");
});

test("the filings-only view still says what a trust files", () => {
  expect(fundFilingsEmpty("IBIT", { count: 3, complete: true }))
    .toBe("IBIT files none of the fund forms ETF lists (prospectus, shareholder reports, N-CEN, N-PORT). Its other filings: fn SEC IBIT.");
  expect(fundFilingsEmpty("IBIT", { count: 0, complete: true })).toBe("No SEC filings found for IBIT.");
});

test("ETF for a fund listed abroad says what ticker says, with its issuer's page, and asks the SEC nothing", async () => {
  let asked = 0;
  const headless = createFundHeadless({
    loadFacts: async () => { asked++; return SPY_FACTS; },
    loadFilings: async () => { asked++; return []; },
    loadAbroadProfile: async (key) => ({
      name: `${key} fund`,
      page: "https://www.chinaamc.com.hk/detail?fundId=HKVAXBT",
      descriptionSource: { publisher: "ChinaAMC (Hong Kong), Product Key Facts on HKEXnews", url: "https://www1.hkexnews.hk/a.pdf" },
    }),
  });
  for (const key of ["3042.HK", "3042:HKEX"]) {
    const result = await headless.load(fundArgs(key), createTestHeadlessContext());
    expect(result.sections[0]).toMatchObject({ title: "Fund facts", rows: [], empty: "Fund facts (fee, NAV, premium) cover US-listed funds only." });
    expect(result.sections[1]!.entries!.map((entry) => [entry.label, entry.value])).toEqual([
      ["Name", `${key} fund`],
      ["Issuer page", "https://www.chinaamc.com.hk/detail?fundId=HKVAXBT"],
      ["Description from", "ChinaAMC (Hong Kong), Product Key Facts on HKEXnews: https://www1.hkexnews.hk/a.pdf"],
    ]);
    expect(result.metadata).toMatchObject({ venue: "HKEX", usListedOnly: true });
  }
  expect(asked).toBe(0);
  // Without a profile the sentence stands alone.
  const bare = await createFundHeadless({ loadFacts: async () => SPY_FACTS, loadFilings: async () => [], loadAbroadProfile: async () => null })
    .load(fundArgs("VUSA:LSE"), createTestHeadlessContext());
  expect(bare.sections).toHaveLength(1);
});
