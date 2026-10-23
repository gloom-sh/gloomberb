import { expect, test } from "bun:test";
import { oneLineFailure, symbolListNotes } from "./history-export";

test("a list's warnings are said once with the symbols they are about, and a failure that names its symbol stands alone", () => {
  expect(symbolListNotes([
    { symbol: "AAPL", notes: ["2026-10-23 is still forming (partial)"] },
    { symbol: "ZZZZQQ", notes: ["Not a ticker: ZZZZQQ."] },
    { symbol: "NESN:SWX", notes: ["2026-10-23 is still forming (partial)"] },
  ])).toEqual(["AAPL, NESN:SWX: 2026-10-23 is still forming (partial)", "Not a ticker: ZZZZQQ."]);
});

test("a symbol of a list that asks which exchange names its listings on one line, as quote's row does", () => {
  const details = [
    "Listings:",
    "  FP:NEO FP Newspapers Inc. (try: gloom history FP:NEO --range 1W)",
    "  FP:BVB S.C. Fondul Proprietatea S.A. (try: gloom history FP:BVB --range 1W)",
  ].join("\n");
  expect(oneLineFailure("Choose an exchange for FP.", details)).toBe("Choose an exchange for FP. Listings: FP:NEO, FP:BVB.");
  expect(oneLineFailure("No history for ZZZZQQ.", undefined)).toBe("No history for ZZZZQQ.");
});

test("a one-letter ticker's warning keeps its attribution: A, F and T are whole words, not the letters inside prose", () => {
  expect(symbolListNotes([
    { symbol: "F", notes: ["Not a ticker: F."] },
    { symbol: "A", notes: ["Asked 5Y, data starts 2023-09-11 (first available bar)", "A gap of 4 days before 2026-10-01"] },
    { symbol: "T", notes: ["2026-10-23 is still forming (partial)"] },
    { symbol: "AAPL", notes: ["2026-10-23 is still forming (partial)"] },
    { symbol: "FB", notes: ["No bars for FB from 2026-10-22 to today."] },
  ])).toEqual([
    "Not a ticker: F.",
    "A: Asked 5Y, data starts 2023-09-11 (first available bar)",
    "A: A gap of 4 days before 2026-10-01",
    "T, AAPL: 2026-10-23 is still forming (partial)",
    "No bars for FB from 2026-10-22 to today.",
  ]);
  // A symbol with a dot or colon is matched whole too, and a longer one that contains it is not it.
  expect(symbolListNotes([
    { symbol: "BRK.B", notes: ["No bars for BRK.B in 1M."] },
    { symbol: "NESN:SWX", notes: ["No bars for NESN:SWX.", "Something about NESN:SWXX"] },
  ])).toEqual(["No bars for BRK.B in 1M.", "No bars for NESN:SWX.", "NESN:SWX: Something about NESN:SWXX"]);
});
