import { describe, expect, test } from "bun:test";
import type { TickerChanges } from "../types/ticker-changes";
import { describeFormerIssuer, describeTickerChange, startTickerChangeLookup, tickerChangeLine } from "./ticker-changes";

const FB: TickerChanges = {
  symbol: "FB",
  moved: { symbol: "META", name: "Meta Platforms, Inc.", hops: [{ from: "FB", to: "META", date: "2022-06-09" }] },
  formerly: null,
  listedName: null,
  changes: [{ from: "FB", to: "META", date: "2022-06-09" }],
};

const TRCH: TickerChanges = {
  symbol: "TRCH",
  moved: {
    symbol: "MMATQ",
    name: "Meta Materials Inc.",
    hops: [{ from: "TRCH", to: "MMAT", date: "2021-07-06" }, { from: "MMAT", to: "MMATQ", date: "2024-08-21" }],
  },
  formerly: null,
  listedName: null,
  changes: [{ from: "TRCH", to: "MMAT", date: "2021-07-06" }],
};

describe("describeTickerChange", () => {
  test("a symbol another security took names it, and where the company that left trades now", () => {
    const change = describeTickerChange("fb", FB, {
      name: "ProShares S&P 500 Dynamic Daily Buffer ETF",
      lastTraded: Date.parse("2026-10-09T20:00:00Z"),
    });
    expect(change).toEqual({
      symbol: "FB",
      kind: "moved",
      note: "FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)",
      changes: [{ from: "FB", to: "META", date: "2022-06-09" }],
      tradesAs: "META",
      issuer: "Meta Platforms",
      listed: "ProShares S&P 500 Dynamic Daily Buffer ETF",
    });
  });

  test("with nothing listed there, or only the company's own old line, the symbol just changed", () => {
    const changed = "FB became META on 2022-06-09";
    expect(describeTickerChange("FB", FB, null)?.note).toBe(changed);
    // A quote that stopped before the change, or that is the company that left, is its old line.
    expect(describeTickerChange("FB", FB, { name: "ProShares Trust", lastTraded: Date.parse("2022-06-08T20:00:00Z") })?.note).toBe(changed);
    expect(describeTickerChange("FB", FB, { name: "Meta Platforms Inc Class A" })?.note).toBe(changed);
    // Without a look of its own, the command goes by what the service lists there.
    expect(describeTickerChange("FB", FB)?.note).toBe(changed);
    expect(describeTickerChange("FB", { ...FB, listedName: "ProShares Fund" })?.note)
      .toBe("FB now lists ProShares Fund; Meta Platforms trades as META (changed 2022-06-09)");
  });

  test("follows a company through each later symbol", () => {
    expect(describeTickerChange("TRCH", TRCH, null)?.note)
      .toBe("TRCH became MMAT on 2021-07-06, then MMATQ on 2024-08-21");
    expect(describeTickerChange("TRCH", { ...TRCH, moved: { ...TRCH.moved!, name: null } }, { name: "Torchlight Fund" })?.note)
      .toBe("TRCH now lists Torchlight Fund; the former TRCH trades as MMATQ (changed to MMAT on 2021-07-06, then MMATQ on 2024-08-21)");
  });

  test("a symbol its holder renamed into keeps what it was before as data, and prints nothing", () => {
    const formerly = (symbol: string, hops: TickerChanges["formerly"]) =>
      describeTickerChange(symbol, { symbol, moved: null, formerly: hops, listedName: null, changes: hops ?? [] });
    const metv = formerly("METV", [{ from: "META", to: "METV", date: "2022-01-31" }]);
    expect(metv?.note).toBe("METV was META until 2022-01-31");
    // Typing META or METV got what was typed: no line beside it.
    expect(tickerChangeLine(metv)).toBeNull();
    expect(tickerChangeLine(describeTickerChange("FB", FB, null))).toBe("FB became META on 2022-06-09");
    expect(formerly("MMATQ", [
      { from: "MMAT", to: "MMATQ", date: "2024-08-21" },
      { from: "TRCH", to: "MMAT", date: "2021-07-06" },
    ])).toMatchObject({
      kind: "formerly",
      note: "MMATQ was MMAT until 2024-08-21, and TRCH until 2021-07-06",
      changes: [{ from: "TRCH", to: "MMAT", date: "2021-07-06" }, { from: "MMAT", to: "MMATQ", date: "2024-08-21" }],
    });
    expect(formerly("AAMCF", null)).toBeNull();
    expect(describeTickerChange("AAPL", null)).toBeNull();
  });
});

describe("describeFormerIssuer", () => {
  // Golden Ocean merged into CMB.Tech in 2025; a fund lists under GOGL now.
  const GOGL: TickerChanges = {
    symbol: "GOGL", moved: null, formerly: null, listedName: null, changes: [],
    formerIssuer: {
      symbol: "GOGL", name: "Golden Ocean Group Ltd", until: "2025-08-20",
      successor: { symbol: "CMBT", name: "Cmb.Tech NV" }, source: "https://www.sec.gov/Archives/edgar/data/1029145/x-index.htm",
    },
  };
  const fund = { name: "Corgi GOOGL 2x Daily ETF", lastTraded: Date.parse("2026-10-16T20:00:00Z") };

  test("a symbol whose company merged away names it and what the company it merged into trades as", () => {
    expect(describeFormerIssuer("gogl", GOGL, fund)).toEqual({
      ...GOGL.formerIssuer!,
      note: "GOGL was Golden Ocean Group until 2025, now Cmb.Tech: CMBT",
    });
    expect(describeFormerIssuer("GOGL", GOGL, null)?.note).toBe("GOGL was Golden Ocean Group until 2025, now Cmb.Tech: CMBT");
    expect(describeFormerIssuer("GOGL", { ...GOGL, formerIssuer: { ...GOGL.formerIssuer!, successor: { symbol: "CMBT", name: null } } })?.note)
      .toBe("GOGL was Golden Ocean Group until 2025, now CMBT");
  });

  test("nothing when the successor is what lists there, took the symbol, or the line is the company's own long after", () => {
    expect(describeFormerIssuer("GOGL", GOGL, { name: "CMB.TECH NV" })).toBeNull();
    expect(describeFormerIssuer("CMBT", { ...GOGL, symbol: "CMBT" }, null)).toBeNull();
    // Its own line, trading a year after the record says it merged: the record is not about this listing.
    expect(describeFormerIssuer("GOGL", GOGL, { name: "Golden Ocean Group Limited", lastTraded: Date.parse("2026-09-01T20:00:00Z") })).toBeNull();
    // Its old line's last print, days around the merger, is still the merged company.
    expect(describeFormerIssuer("GOGL", GOGL, { name: "Golden Ocean Group Limited", lastTraded: Date.parse("2025-08-19T20:00:00Z") })?.symbol).toBe("GOGL");
    expect(describeFormerIssuer("FB", FB, fund)).toBeNull();
  });

  test("the service's record is read only when whole", async () => {
    const lookup = (payload: unknown) => startTickerChangeLookup({ getTickerChanges: async () => payload as TickerChanges }, "GOGL").settle();
    expect((await lookup(GOGL))?.formerIssuer?.successor.symbol).toBe("CMBT");
    const partial = await lookup({ ...GOGL, symbol: "EGLE", formerIssuer: { symbol: "EGLE", name: "Eagle Bulk Shipping Inc.", successor: { symbol: "SBLK" } } });
    expect(partial && "formerIssuer" in partial).toBe(false);
  });
});

describe("startTickerChangeLookup", () => {
  test("looks a symbol up once per session, and only a US symbol", async () => {
    const asked: string[] = [];
    const source = { getTickerChanges: async (symbol: string) => { asked.push(symbol); return FB; } };
    expect(await startTickerChangeLookup(source, "fb").settle()).toEqual(FB);
    expect(await startTickerChangeLookup(source, "FB", "NASDAQ").settle()).toEqual(FB);
    for (const [symbol, exchange] of [["SAN", "EPA"], ["BTC-USD", ""], ["GC=F", ""], ["^VIX", ""]] as const) {
      expect(await startTickerChangeLookup(source, symbol, exchange).settle()).toBeNull();
    }
    expect(asked).toEqual(["FB"]);
    expect(await startTickerChangeLookup({}, "FB").settle()).toBeNull();
  });

  test("an offline or slow service means no note, never a wait past the grace or a failure", async () => {
    const failing = { getTickerChanges: async () => { throw new Error("fetch failed"); } };
    expect(await startTickerChangeLookup(failing, "FB").settle()).toBeNull();

    let signal: AbortSignal | undefined;
    const slow = {
      getTickerChanges: (_symbol: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise<TickerChanges | null>(() => {});
      },
    };
    const started = performance.now();
    expect(await startTickerChangeLookup(slow, "FB").settle(20)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    // Given up on, the request is stopped rather than left holding the process open.
    expect(signal?.aborted).toBe(true);
  });
});
