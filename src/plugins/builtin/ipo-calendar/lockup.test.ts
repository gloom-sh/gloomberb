import { expect, test } from "bun:test";
import type { IpoCalendarPayload, IpoDeal } from "../../../api-client/ipo";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { validateIpoCalendar } from "./client";
import { ipoCalendarHeadless, projectIpoCalendarHeadless } from "./headless";
import { ipoDetailNotes, ipoDetailSentences, ipoMetricRows, ipoPriceNow, loadIpoLockupNews, loadListingIpo } from "./listing-ipo";
import { quoteHeadlineTime } from "../../../market-data/market/status";
import { filterIpoDeals, formatIpoLockupDate, formatIpoLockupEnd, formatIpoPrice, ipoKeyword, ipoLockupBasis, ipoLockupText, ipoReturnSince } from "./model";
import { ipoDeal } from "./test-fixture";

const NOW = new Date("2026-10-28T19:00:00Z");

/** HawkEye 360: priced at $26 on 6 May 2026, first traded on the NYSE the next day; its 424B4 states 180 days. */
const HAWK: IpoDeal = ipoDeal({
  id: "hawk", company: "HawkEye 360, Inc.", symbol: "HAWK", mic: "XNYS", exchange: "NYSE", venue: "NYSE",
  listingDate: "2026-05-07", dateKind: "actual", status: "listed", offerPrice: 26,
  firstDay: { session: "2026-05-07", open: 33.8, close: 31.2, returnPct: 0.2 },
  lockup: { endsOn: "2026-11-02", days: 180, basis: "prospectus", prospectusDate: "2026-05-06",
    prospectusUrl: "https://www.sec.gov/Archives/edgar/data/1750704/000162828026032207/hawkeye-424b4.htm" },
});

/** Game Your Game: a direct listing, so no offer price and no money raised. */
const GYGY: IpoDeal = ipoDeal({
  id: "gygy", company: "Game Your Game Inc.", symbol: "GYGY", listingDate: "2026-07-30", status: "listed", listingType: "direct",
  firstDay: { session: "2026-07-30", open: 22.5, close: 24, returnPct: null },
});

const SPAC: IpoDeal = ipoDeal({ id: "spac", company: "Example Acquisition Corp", symbol: "EXAC", listingType: "spac", status: "listed", listingDate: "2026-09-01", offerPrice: 10 });

function args(argument: string, options: Record<string, unknown> = {}): HeadlessPaneLoadArgs {
  return { argument, options, symbols: [] } as unknown as HeadlessPaneLoadArgs;
}

const payload = (deals: IpoDeal[], sources: IpoCalendarPayload["sources"] = []): IpoCalendarPayload => ({ asOf: "2026-10-28T19:00:00Z", deals, sources });

test("a direct listing reads that it has no offer price, short in the pane's column and in full in a report", () => {
  expect(formatIpoPrice(GYGY)).toBe("direct listing");
  expect(formatIpoPrice(GYGY, { full: true })).toBe("direct listing, no offer price");
  expect(formatIpoPrice(HAWK, { full: true })).toBe("$26");
  // A deal with no terms yet is still a dash.
  expect(formatIpoPrice(ipoDeal({ id: "none" }), { full: true })).toBe("—");
});

test("the lock-up estimate reads as one: ends, or ended, about a date", () => {
  expect(formatIpoLockupEnd(HAWK.lockup?.endsOn)).toBe("~2026-11-02");
  expect(formatIpoLockupEnd(GYGY.lockup?.endsOn)).toBe("—");
  // The pane's LOCKUP reads the same day, with the year once it is half a year off.
  expect(formatIpoLockupDate(HAWK.lockup?.endsOn, NOW)).toBe("~2 Nov");
  expect(formatIpoLockupDate("2027-05-07", NOW)).toBe("~7 May 2027");
  expect(ipoLockupText(HAWK, NOW)).toBe("lockup ends ~2026-11-02 (estimate)");
  expect(ipoLockupText(HAWK, new Date("2026-11-03T00:00:00Z"))).toBe("lockup ended ~2026-11-02 (estimate)");
  expect(ipoLockupText(GYGY, NOW)).toBeNull();
});

test("the return since the IPO counts from the offer price, a direct listing's from its first trade", () => {
  expect(ipoReturnSince(HAWK, 42.3)).toMatchObject({ basis: "offer", from: 26 });
  expect(ipoReturnSince(HAWK, 42.3)!.returnPct).toBeCloseTo(0.6269, 4);
  expect(ipoReturnSince(GYGY, 30)).toMatchObject({ basis: "first trade", from: 22.5 });
  expect(ipoReturnSince(HAWK, null)).toBeNull();
  expect(ipoReturnSince(ipoDeal({ id: "x", status: "listed" }), 10)).toBeNull();
});

test("lockup, lock-up, SPAC and de-SPAC are kinds of deal to list, not names to look for", () => {
  for (const word of ["lockup", "Lock-up", "lock up", "LOCKUPS"]) expect(ipoKeyword(word)).toBe("lockup");
  expect(ipoKeyword("SPAC")).toBe("spac");
  expect(ipoKeyword("de-SPAC")).toBe("de-spac");
  expect(ipoKeyword("despac")).toBe("de-spac");
  expect(ipoKeyword("HawkEye")).toBeNull();
  const deals = [HAWK, GYGY, SPAC];
  expect(filterIpoDeals(deals, "all", "lock-up", NOW).map((deal) => deal.id)).toEqual(["hawk"]);
  expect(filterIpoDeals(deals, "all", "SPAC", NOW).map((deal) => deal.id)).toEqual(["spac"]);
  expect(filterIpoDeals(deals, "all", "de-SPAC", NOW).map((deal) => deal.id)).toEqual(["spac"]);
  const spacs = projectIpoCalendarHeadless(payload(deals), args("de-SPAC"), null, NOW);
  expect(spacs.notes).toEqual(["A SPAC's merger with its target (de-SPAC) is no IPO, so the calendar lists the SPACs' own IPOs."]);
});

test("one deal found reads its IPO date, offer price, return since the IPO, lock-up estimate and lock-up news", () => {
  const news = [{ title: "HawkEye 360 Confirms Early Lock-up Release for September 2nd", source: "PR Newswire",
    publishedAt: "2026-08-31T11:41:00.000Z", url: "https://example.com/hawk" }];
  const result = projectIpoCalendarHeadless(payload([HAWK, GYGY]), args("HawkEye"), { price: { price: 42.3, at: null }, news }, NOW);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ ticker: "HAWK", price: "$26", lockupEnds: "2026-11-02", lockupBasis: "prospectus", prospectusDate: "2026-05-06" });
  expect(result.notes).toEqual([
    "HAWK listed 2026-05-07 on NYSE at a $26 offer price, +20.0% on the first day; $42.30 now, +62.7% since the IPO.",
    "HAWK lockup ends ~2026-11-02 (estimate): 180 days from the prospectus dated 2026-05-06; underwriters can release shares early.",
    "Lock-up news 2026-08-31: HawkEye 360 Confirms Early Lock-up Release for September 2nd (PR Newswire)",
  ]);
  const direct = projectIpoCalendarHeadless(payload([HAWK, GYGY]), args("GYGY"), { price: { price: 30, at: null }, news: [] }, NOW);
  expect(direct.rows[0]).toMatchObject({ price: "direct listing, no offer price", lockupEnds: null });
  expect(direct.notes).toEqual(["GYGY listed 2026-07-30 on Nasdaq: direct listing, no offer price; $30 now, +33.3% since the first trade at $22.50."]);
  // Several deals found: rows only, and a cut list says how to see the rest.
  expect(projectIpoCalendarHeadless(payload([HAWK, GYGY]), args(""), null, NOW).notes).toBeUndefined();
  const cut = projectIpoCalendarHeadless(payload([HAWK, GYGY, SPAC]), args("", { limit: 2 }), null, NOW);
  expect(cut.rows).toHaveLength(2);
  expect(cut.notes).toEqual(["Showing 2 of 3 deals; --limit 3 lists them all."]);
});

test("the price since the IPO is the one quote heads the listing with: after the close, the close and its day, never an after-hours print", () => {
  // Tue 24 Nov 2026 after the close: the close 16.62 is the regular session's; 16.50 traded after hours.
  const quote = {
    symbol: "HAWK", price: 16.5, currency: "USD", change: -0.06, changePercent: -0.36, previousClose: 16.68,
    regularClose: 16.62, regularCloseSessionDate: "2026-11-24", regularChange: -0.06, regularChangePercent: -0.36,
    marketState: "POST", postMarketPrice: 16.5, postMarketChange: -0.12, lastUpdated: Date.parse("2026-11-24T23:40:00Z"),
    changeSessionDate: "2026-11-24", exchangeName: "NYSE",
  } as const;
  const quoted = ipoPriceNow(quote as never);
  expect(quoted).toEqual({ price: 16.62, at: "at the 2026-11-24 close" });
  expect(ipoDetailSentences(HAWK, quoted, [], NOW)[0]).toBe(
    "HAWK listed 2026-05-07 on NYSE at a $26 offer price, +20.0% on the first day; $16.62 at the 2026-11-24 close, -36.1% since the IPO.");
  // While the session trades, the live price with the time it was read.
  expect(ipoPriceNow({ ...quote, price: 16.8, marketState: "REGULAR", lastUpdated: Date.parse("2026-11-25T15:02:30Z") } as never))
    .toEqual({ price: 16.8, at: "as of 2026-11-25 15:02 UTC" });
  // London's session was over by 16:40 on Tue 24 Nov; the quote was stamped at 17:12. `quote` dates its price at that close, and so does this.
  const london = { symbol: "EXPL", price: 412.5, currency: "GBp", change: 2.5, changePercent: 0.61, previousClose: 410,
    marketState: "CLOSED", lastUpdated: Date.parse("2026-11-24T17:12:00Z"), changeSessionDate: "2026-11-24",
    exchangeName: "LSE", listingExchangeName: "LSE" };
  expect(quoteHeadlineTime(london as never)).toBe(Date.parse("2026-11-24T16:40:00Z"));
  expect(ipoPriceNow(london as never)).toEqual({ price: 412.5, at: "as of 2026-11-24 16:40 UTC" });
});

test("a report names only the markets behind that its deals are on, with the day each was last read", () => {
  const sources = [
    { id: "nasdaq", mics: ["XNAS", "XNYS"], ok: true, asOf: "2026-10-28T18:00:00Z" },
    { id: "lse", mics: ["XLON"], ok: false, asOf: "2026-10-22T20:44:06Z" },
  ];
  const lse = ipoDeal({ id: "lse", company: "Example plc", symbol: "EXPL", mic: "XLON", exchange: "LSE", venue: "LSE", country: "GB", region: "europe" });
  expect(projectIpoCalendarHeadless(payload([HAWK, lse], sources), args(""), null, NOW).errors).toEqual(["UK not updated since 2026-10-22"]);
  // A search that found a US deal says nothing of London's; one that found nothing still says what is behind.
  expect(projectIpoCalendarHeadless(payload([HAWK, lse], sources), args("HawkEye"), null, NOW).errors).toBeUndefined();
  expect(projectIpoCalendarHeadless(payload([HAWK, lse], sources), args("nothing"), null, NOW).errors).toEqual(["UK not updated since 2026-10-22"]);
});

test("ticker's IPO rows, and the lines under them", () => {
  expect(ipoMetricRows(HAWK, 42.3, NOW)).toEqual([
    ["IPO date", "2026-05-07 on NYSE"],
    ["Offer", "$26"],
    ["Since IPO", "+62.7% ($26 to $42.30)"],
    ["Lockup", "ends ~2026-11-02 (estimate)"],
  ]);
  expect(ipoMetricRows(GYGY, 30, NOW)).toEqual([
    ["IPO date", "2026-07-30 on Nasdaq"],
    ["Offer", "direct listing, no offer price"],
    ["Since IPO", "+33.3% (first trade $22.50 to $30)"],
  ]);
  const typical = { ...HAWK, lockup: { ...HAWK.lockup!, basis: "typical" as const, prospectusDate: null, prospectusUrl: null, endsOn: "2026-11-03" } };
  expect(ipoDetailNotes(typical, [])).toEqual([
    "Lockup estimate: the typical 180 days from the first session on 2026-05-07; the prospectus has not been read; underwriters can release shares early.",
  ]);
  expect(ipoDetailSentences(typical, null, [], NOW)[1]).toBe(
    "HAWK lockup ends ~2026-11-03 (estimate): the typical 180 days from the first session on 2026-05-07; the prospectus has not been read; underwriters can release shares early.");
});

test("the lock-up basis says what the server counted: the prospectus's period or the typical one, from the prospectus date or the first session", () => {
  const basis = (lockup: Partial<NonNullable<IpoDeal["lockup"]>>) => ipoLockupBasis({ ...HAWK, lockup: { ...HAWK.lockup!, ...lockup } });
  expect(basis({})).toBe("180 days from the prospectus dated 2026-05-06");
  // A prospectus read with no lock-up period it states: the typical period from its date, read.
  expect(basis({ basis: "typical", prospectusUrl: "https://www.sec.gov/x.htm" })).toBe("the typical 180 days from the prospectus dated 2026-05-06");
  expect(basis({ basis: "typical", prospectusDate: null, prospectusUrl: "https://www.sec.gov/x.htm" }))
    .toBe("the typical 180 days from the first session on 2026-05-07");
  // A period the prospectus states, with no date read from it: counted from the first session, and never "the usual".
  expect(basis({ days: 90, prospectusDate: null })).toBe("90 days from the first session on 2026-05-07, the period the prospectus states");
  expect(basis({ basis: "typical", prospectusDate: null, prospectusUrl: null }))
    .toBe("the typical 180 days from the first session on 2026-05-07; the prospectus has not been read");
});

test("the calendar asks for the listings from --from, and a lock-up estimate it cannot read is left off its deal only", async () => {
  const asked: unknown[] = [];
  const client = {
    getCloudIpoCalendar: async (params: unknown) => { asked.push(params); return payload([HAWK]); },
    searchCloudNews: async () => ({ items: [], nextCursor: null }),
  };
  const marketData = { getQuote: async () => ({ price: 42.3 }) };
  const result = await ipoCalendarHeadless.load(args("", { from: "2025-11-01", status: "all" }),
    { apiClient: client, marketData, signal: new AbortController().signal } as never);
  expect(asked).toEqual([{ from: "2025-11-01" }]);
  expect(result.rows[0]).toMatchObject({ ticker: "HAWK", lockupEnds: "2026-11-02" });
  expect(ipoCalendarHeadless.options!.find((option) => option.key === "from")!.normalize!("1.11.2025")).toBe("2025-11-01");

  const unreadable = validateIpoCalendar(payload([{ ...HAWK, lockup: { endsOn: "soon" } as never }]));
  expect(unreadable.deals).toHaveLength(1);
  expect(unreadable.deals[0]).not.toHaveProperty("lockup");
});

test("a listing's IPO is the one deal listed under its symbol on its exchange; its lock-up news is about the lock-up since it listed", async () => {
  const asked: unknown[] = [];
  const client = {
    getCloudIpoCalendar: async (params: unknown) => {
      asked.push(params);
      return payload([HAWK, { ...HAWK, id: "other", exchange: "NASDAQ", mic: "XNAS" }]);
    },
  };
  expect(await loadListingIpo(client, { symbol: "hawk", exchange: "NYSE" }, { now: NOW })).toBe(HAWK);
  expect(asked[0]).toEqual({ q: "HAWK", from: "2025-09-23", to: "2026-10-28" });
  // Two deals under the symbol and no exchange to tell them apart: none.
  expect(await loadListingIpo(client, { symbol: "HAWK" }, { now: NOW })).toBeNull();

  const searched: unknown[] = [];
  const story = (headline: string, at: string) => ({ headline, primaryPublisher: "PR Newswire", primarySource: "prnewswire",
    lastPublishedAt: at, firstPublishedAt: at, primaryUrl: `https://example.com/${at}` });
  const news = await loadIpoLockupNews({
    searchCloudNews: async (...request: unknown[]) => {
      searched.push(request);
      return { items: [story("HawkEye 360 Confirms Early Lock-up Release for September 2nd", "2026-08-31T11:41:00.000Z"),
        story("HawkEye 360 reports second quarter results", "2026-08-12T20:00:00.000Z"),
        story("Before the IPO: lockup agreements signed", "2026-04-01T00:00:00.000Z")], nextCursor: null } as never;
    },
  }, HAWK);
  expect(searched).toEqual([["lock-up", 20, undefined, { tickers: ["HAWK:XNYS"] }]]);
  expect(news.map((item) => item.title)).toEqual(["HawkEye 360 Confirms Early Lock-up Release for September 2nd"]);
});
