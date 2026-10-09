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
