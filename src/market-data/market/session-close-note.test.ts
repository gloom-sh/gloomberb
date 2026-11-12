import { expect, test } from "bun:test";
import { mixedSessionCloseNote } from "./session-close-note";

const equity = { symbol: "IBIT", exchange: "NASDAQ" };
const crypto = { symbol: "BTC-USD", exchange: "CCC" };

test("a US equity against crypto names both closes and their offset, and follows daylight time", () => {
  expect(mixedSessionCloseNote(equity, crypto, "2026-10-08"))
    .toBe("IBIT closes 20:00 UTC; BTC-USD bar is 00:00 UTC (4 h offset). Daily pairs are matched by date.");
  expect(mixedSessionCloseNote(equity, crypto, "2026-12-08"))
    .toBe("IBIT closes 21:00 UTC; BTC-USD bar is 00:00 UTC (3 h offset). Daily pairs are matched by date.");
  expect(mixedSessionCloseNote({ symbol: "AAPL", exchange: "NASDAQ" }, { symbol: "VOD", exchange: "LSE", label: "VOD:LSE" }, "2026-10-08"))
    .toBe("AAPL closes 20:00 UTC; VOD:LSE closes 15:40 UTC (4 h 20 min offset). Daily pairs are matched by date.");
});

test("pairs that close together, or whose close is unknown, get no note", () => {
  expect(mixedSessionCloseNote(equity, { symbol: "MSFT", exchange: "NASDAQ" }, "2026-10-08")).toBeNull();
  expect(mixedSessionCloseNote(equity, { symbol: "KO", exchange: "NYSE" }, "2026-10-08")).toBeNull();
  expect(mixedSessionCloseNote(crypto, { symbol: "EURUSD=X", exchange: "CCY" }, "2026-10-08")).toBeNull();
  expect(mixedSessionCloseNote(equity, { symbol: "MSFT" }, "2026-10-08")).toBeNull();
  expect(mixedSessionCloseNote(equity, { symbol: "XYZ", exchange: "UNKNOWNX" }, "2026-10-08")).toBeNull();
});

test("a future's daily bar closes at its settlement, not at the midnight it is stamped", () => {
  // NG settles at 14:30 New York time: 19:30 UTC in November, 18:30 UTC in October's daylight time.
  expect(mixedSessionCloseNote({ symbol: "EQT", exchange: "NYSE" }, { symbol: "NG=F", exchange: "NYM" }, "2026-11-11"))
    .toBe("EQT closes 21:00 UTC; NG=F settles 19:30 UTC (1 h 30 min offset). Daily pairs are matched by date.");
  expect(mixedSessionCloseNote({ symbol: "GLD", exchange: "NYSEARCA" }, { symbol: "GC=F", exchange: "CMX" }, "2026-10-08"))
    .toBe("GLD closes 20:00 UTC; GC=F settles 17:30 UTC (2 h 30 min offset). Daily pairs are matched by date.");
  // A future whose settlement time is not listed keeps the time its bar is stamped with, so the note never disappears.
  expect(mixedSessionCloseNote({ symbol: "SPY", exchange: "NYSEARCA" }, { symbol: "TTF=F", exchange: "NYM" }, "2026-11-11"))
    .toBe("SPY closes 21:00 UTC; TTF=F bar is 00:00 UTC (3 h offset). Daily pairs are matched by date.");
  expect(mixedSessionCloseNote({ symbol: "SPY", exchange: "NYSEARCA" }, { symbol: "KC=F", exchange: "NYB" }, "2026-11-11"))
    .toBe("SPY closes 21:00 UTC; KC=F bar is 00:00 UTC (3 h offset). Daily pairs are matched by date.");
  // ES settles with the cash close at 16:00 New York: together, no note.
  expect(mixedSessionCloseNote({ symbol: "SPY", exchange: "NYSEARCA" }, { symbol: "ES=F", exchange: "CME" }, "2026-10-08")).toBeNull();
});
