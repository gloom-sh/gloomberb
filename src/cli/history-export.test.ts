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
