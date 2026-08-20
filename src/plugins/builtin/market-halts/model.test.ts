import { afterEach, describe, expect, test } from "bun:test";
import { ConnectionHealthRegistry } from "../../../core/connection-health";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  NASDAQ_HALTS_CONNECTION_ID,
  acquireMarketHaltsHealth,
  fetchMarketHalts,
  parseHaltFeed,
} from "./client";
import {
  DEFAULT_HALT_SORT,
  etWallClockToUtcMs,
  filterHalts,
  formatEtResumption,
  resolveHaltStatus,
  sortHalts,
} from "./model";

function item(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([tag, value]) => (value === "" ? `<ndaq:${tag} />` : `<ndaq:${tag}>${value}</ndaq:${tag}>`))
    .join("");
  return `<item><title>${fields.IssueSymbol ?? ""}</title>${body}</item>`;
}

const SUMMER_HALT = item({
  HaltDate: "08/20/2026",
  HaltTime: "15:41:44.413",
  IssueSymbol: "adxn",
  IssueName: "Addex &amp; Co ADS",
  Market: "NASDAQ",
  ReasonCode: "LUDP",
  ResumptionDate: "08/20/2026",
  ResumptionQuoteTime: "15:41:44",
  ResumptionTradeTime: "15:46:44",
});

const WINTER_HALT = item({
  HaltDate: "01/15/2026",
  HaltTime: "09:30:00",
  IssueSymbol: "WNTR",
  IssueName: "Winter Corp",
  Market: "NYSE",
  ReasonCode: "T12",
  ResumptionDate: "",
  ResumptionQuoteTime: "",
  ResumptionTradeTime: "",
});

const OVERNIGHT_HALT = item({
  HaltDate: "08/19/2026",
  HaltTime: "16:10:00",
  IssueSymbol: "OVER",
  IssueName: "Overnight Inc",
  Market: "AMEX",
  ReasonCode: "T3",
  ResumptionDate: "08/20/2026",
  ResumptionQuoteTime: "09:20:00",
  ResumptionTradeTime: "09:30:00",
});

function feed(...items: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><rss xmlns:ndaq="http://www.nasdaqtrader.com/"><channel>${items.join("")}</channel></rss>`;
}

afterEach(() => {
  setHttpFetchTransport(null);
});

describe("parseHaltFeed", () => {
  test("reads Nasdaq fields as America/New_York across both DST offsets", () => {
    const { records } = parseHaltFeed(feed(SUMMER_HALT, WINTER_HALT));

    // 15:41:44.413 EDT is 19:41:44.413Z; 09:30:00 EST is 14:30:00Z.
    expect(new Date(records[0]!.haltedAt).toISOString()).toBe("2026-08-20T19:41:44.413Z");
    expect(new Date(records[1]!.haltedAt).toISOString()).toBe("2026-01-15T14:30:00.000Z");
  });

  test("normalizes the symbol, decodes entities, and expands the reason code", () => {
    const [record] = parseHaltFeed(feed(SUMMER_HALT)).records;

    expect(record?.symbol).toBe("ADXN");
    expect(record?.company).toBe("Addex & Co ADS");
    expect(record?.reason).toBe("Volatility pause");
  });

  test("leaves resumption times null when the feed has not set them", () => {
    const [record] = parseHaltFeed(feed(WINTER_HALT)).records;

    expect(record?.quoteResumeAt).toBeNull();
    expect(record?.tradeResumeAt).toBeNull();
  });

  test("reports item count so an unreadable feed is not read as zero halts", () => {
    const result = parseHaltFeed(feed("<item><title>ADXN</title><halt>who knows</halt></item>"));

    expect(result.records).toHaveLength(0);
    expect(result.itemCount).toBe(1);
  });
});

describe("fetchMarketHalts", () => {
  test("tracks parse failures as connection errors", async () => {
    const health = new ConnectionHealthRegistry();
    const release = acquireMarketHaltsHealth(health);
    setHttpFetchTransport(async () => new Response(feed("<item><x/></item>")));

    await expect(fetchMarketHalts(health)).rejects.toThrow(/format/i);
    expect(health.getSnapshot().sources.find((source) => source.id === NASDAQ_HALTS_CONNECTION_ID)?.status)
      .toBe("error");
    release();
  });

  test("rejects a successful HTML response instead of reporting a quiet day", async () => {
    setHttpFetchTransport(async () => new Response("<html>blocked</html>"));

    await expect(fetchMarketHalts()).rejects.toThrow(/not RSS/i);
  });

  test("returns an empty list for a feed with no items", async () => {
    setHttpFetchTransport(async () => new Response(feed()));

    await expect(fetchMarketHalts()).resolves.toEqual([]);
  });
});

describe("etWallClockToUtcMs", () => {
  test("resolves the ambiguous fall-back hour with the offset in force", () => {
    // 01:30 on 2026-11-01 happens twice; the first (EDT, -4) instant wins.
    expect(new Date(etWallClockToUtcMs(2026, 11, 1, 1, 30, 0)).toISOString())
      .toBe("2026-11-01T05:30:00.000Z");
    // 03:00 the same morning is unambiguously EST (-5).
    expect(new Date(etWallClockToUtcMs(2026, 11, 1, 3, 0, 0)).toISOString())
      .toBe("2026-11-01T08:00:00.000Z");
  });
});

describe("halt status", () => {
  const [summer, winter, overnight] = parseHaltFeed(feed(SUMMER_HALT, WINTER_HALT, OVERNIGHT_HALT)).records;
  const records = [summer!, winter!, overnight!];

  test("walks halted, quote-resumed, then resumed as the clock passes each time", () => {
    const beforeQuote = summer!.quoteResumeAt! - 1_000;
    const betweenQuoteAndTrade = summer!.quoteResumeAt! + 1_000;
    const afterTrade = summer!.tradeResumeAt! + 1_000;

    expect(resolveHaltStatus(summer!, beforeQuote)).toBe("halted");
    expect(resolveHaltStatus(summer!, betweenQuoteAndTrade)).toBe("quote");
    expect(resolveHaltStatus(summer!, afterTrade)).toBe("resumed");
  });

  test("stays halted forever without resumption times", () => {
    expect(resolveHaltStatus(winter!, Date.now())).toBe("halted");
  });

  test("filters active against resumed at the same instant", () => {
    const now = summer!.tradeResumeAt! + 1_000;

    expect(filterHalts(records, "active", now).map((row) => row.symbol)).toEqual(["WNTR"]);
    expect(filterHalts(records, "resumed", now).map((row) => row.symbol)).toEqual(["ADXN", "OVER"]);
    expect(filterHalts(records, "all", now)).toHaveLength(3);
  });
});

describe("halt table", () => {
  const records = parseHaltFeed(feed(SUMMER_HALT, WINTER_HALT, OVERNIGHT_HALT)).records;

  test("defaults to newest halt first", () => {
    expect(sortHalts(records, DEFAULT_HALT_SORT, Date.now()).map((row) => row.symbol))
      .toEqual(["ADXN", "OVER", "WNTR"]);
  });

  test("sorts by a chosen column in both directions", () => {
    expect(sortHalts(records, { columnId: "symbol", direction: "desc" }, Date.now()).map((row) => row.symbol))
      .toEqual(["WNTR", "OVER", "ADXN"]);
    expect(sortHalts(records, { columnId: "market", direction: "asc" }, Date.now()).map((row) => row.market))
      .toEqual(["AMEX", "NASDAQ", "NYSE"]);
  });

  test("dates a resumption that lands on another session", () => {
    const overnight = records.find((row) => row.symbol === "OVER")!;
    const sameDay = records.find((row) => row.symbol === "ADXN")!;

    expect(formatEtResumption(overnight.tradeResumeAt, overnight.haltedAt)).toBe("08/20 09:30");
    expect(formatEtResumption(sameDay.tradeResumeAt, sameDay.haltedAt)).toBe("15:46:44");
  });
});
