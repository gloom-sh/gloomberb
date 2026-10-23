import { expect, test } from "bun:test";
import type { HolderData } from "../../../types/financials";
import { thirteenFAction } from "./beneficial-model";
import {
  formatHolderChangePercent,
  formatHolderOwnershipPercent,
  holderStakeMarketCap,
  holderValueCurrency,
  resolveHolderOwnershipPercent,
} from "./format";
import { HOLDER_REPORT_COLUMNS, holderReportRows } from "./report-rows";

test("resolves holder ownership from provider percent before value over market cap", () => {
  expect(resolveHolderOwnershipPercent({ percentHeld: 0.085, value: 120 }, 1_000)).toBe(0.085);
  expect(resolveHolderOwnershipPercent({ value: 120 }, 1_000)).toBe(0.12);
  expect(resolveHolderOwnershipPercent({ value: 120 }, undefined)).toBeUndefined();
  expect(formatHolderOwnershipPercent(0.085)).toBe("8.50%");
});

test("divides a value only by a market cap in the values' currency", () => {
  // BHP London: dollar values from the 13F filings, a sterling market cap.
  const valueCurrency = holderValueCurrency({ currency: "GBp", valueCurrency: "USD" });
  expect(valueCurrency).toBe("USD");
  expect(holderStakeMarketCap(110e9, "GBP", valueCurrency)).toBeUndefined();
  expect(holderStakeMarketCap(215e9, "USD", valueCurrency)).toBe(215e9);
  // An older service: the values are in the listing's currency.
  expect(holderValueCurrency({ currency: "GBp" })).toBe("GBp");
  expect(holderStakeMarketCap(110e9, undefined, "GBp")).toBe(110e9);
  // A stake that two decimals would round away is not shown as a zero.
  expect(formatHolderOwnershipPercent(0.000013)).toBe("<0.01%");
  expect(formatHolderOwnershipPercent(0)).toBe("0.00%");
});

test("a holder's change is a fraction of its prior position however far it moved", () => {
  // PBR at 2026-06-30: Capital World Investors went from 14.10M to 29.42M shares, and
  // once read +1.09% because a change above 1 was taken to be in percent already.
  const data: HolderData = {
    symbol: "PBR",
    holders: [
      { ownerType: "institution", name: "Capital World Investors", value: 753_727_922, shares: 29_419_512,
        changeShares: 15_317_357, changePercent: 1.086171, percentHeld: 0.0079 },
      { ownerType: "institution", name: "Sold most", value: 10_000_000, shares: 4_000_000,
        changeShares: -6_000_000, changePercent: -0.6, percentHeld: 0.0011 },
    ],
  };
  const rows = holderReportRows(data);
  expect(rows.map((row) => [row.changePercent, row.percentHeld])).toEqual([[108.617, 0.79], [-60, 0.11]]);
  const chg = HOLDER_REPORT_COLUMNS.find((column) => column.key === "changePercent")!;
  expect(rows.map((row) => chg.format!(row.changePercent, row))).toEqual(["+108.62%", "-60.00%"]);
  // The pane and its 13D/G tab read the record's fraction the same way.
  expect(formatHolderChangePercent(1.086171)).toBe("+108.62%");
  expect(formatHolderChangePercent(-0.6)).toBe("-60.00%");
  expect(thirteenFAction({ ownerType: "institution", name: "Capital World Investors", changePercent: 1.086171 })?.label).toBe("+109%");
  expect(thirteenFAction({ ownerType: "institution", name: "Sold most", changePercent: -0.6 })?.label).toBe("-60%");
});
