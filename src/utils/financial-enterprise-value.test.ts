import { expect, test } from "bun:test";
import type { Fundamentals } from "../types/financials";
import { buildOverviewStats } from "../plugins/builtin/ticker-detail/overview/model";
import {
  BANK_ENTERPRISE_VALUE, enterpriseValueReconciliationNote, financialEnterpriseValue, financialEnterpriseValueReason,
  INSURER_ENTERPRISE_VALUE, withFinancialEnterpriseValue,
} from "./fundamentals";

test("a bank's and an insurer's EV is not meaningful; a capital markets firm's, an asset manager's, an exchange's and an insurance broker's is", () => {
  expect(["Banks - Diversified", "Banks - Regional"].map(financialEnterpriseValueReason)).toEqual([BANK_ENTERPRISE_VALUE, BANK_ENTERPRISE_VALUE]);
  expect(["Insurance - Life", "Insurance - Property & Casualty", "Insurance - Diversified", "Insurance - Reinsurance", "Insurance - Specialty"]
    .map(financialEnterpriseValueReason)).toEqual(Array(5).fill(INSURER_ENTERPRISE_VALUE));
  expect(["Capital Markets", "Asset Management", "Financial Data & Stock Exchanges", "Insurance Brokers", "Credit Services", "Software - Infrastructure", null]
    .map(financialEnterpriseValueReason)).toEqual(Array(7).fill(null));
});

/**
 * The screener's profiles on November 13, 2026: 79 listings under "Capital Markets". Dealers are among them, but so
 * are advisers, trading venues and bitcoin miners whose EV measures the business, served with EV/revenue and
 * EV/EBITDA; the industry alone cannot tell them apart, so none of them reads N/M.
 */
test("a capital markets firm with a real EV keeps it: Evercore, Moelis, Houlihan Lokey, MarketAxess, Tradeweb, Riot", () => {
  const sample: Array<[string, number, number]> = [
    ["EVR", 11.3e9, 2.38], ["MC", 4.2e9, 2.67], ["HLI", 10.2e9, 3.87], ["MKTX", 5.8e9, 6.44], ["TW", 27.8e9, 11.34], ["RIOT", 6.7e9, 9.72],
  ];
  for (const [symbol, marketCap, enterpriseToRevenue] of sample) {
    const served: Fundamentals = { marketCap, marketCapCurrency: "USD", enterpriseValue: marketCap * 0.95, enterpriseToRevenue };
    const shown = withFinancialEnterpriseValue(served, { industry: "Capital Markets" });
    expect([symbol, shown]).toEqual([symbol, served]);
    expect(financialEnterpriseValue(shown)).toBeNull();
    expect(stat(shown)?.value).not.toBe("N/M");
  }
});

const stat = (fundamentals: Fundamentals | undefined) => buildOverviewStats({
  quote: undefined, fundamentals, quoteCurrency: "HKD", baseCurrency: "USD", toBase: (value) => value,
}).find((entry) => entry.label === "EV");

test("DES: AIA's EV reads N/M for insurers where it read a dash, HSBC's N/M for banks", () => {
  // AIA on November 12, 2026: the source's EV withdrawn, an EV line with a dash.
  const aia: Fundamentals = { marketCap: 760e9, marketCapCurrency: "HKD", unavailableFields: ["enterpriseValue"] };
  expect(stat(aia)).toEqual({ label: "EV", value: "—" });
  const insurer = withFinancialEnterpriseValue(aia, { industry: "Insurance - Life" });
  expect(stat(insurer)).toEqual({ label: "EV", value: "N/M", detail: "for insurers" });
  expect(financialEnterpriseValue(insurer)).toBe(INSURER_ENTERPRISE_VALUE);
  // The line itself says why: no "EV N/M: ..." note beside it.
  expect(enterpriseValueReconciliationNote(insurer)).toBeUndefined();
  const served: Fundamentals = { marketCap: 1.7e12, marketCapCurrency: "HKD", enterpriseValue: 2.4e12, enterpriseToRevenue: 4.5 };
  expect(stat(withFinancialEnterpriseValue(served, { industry: "Banks - Diversified" }))).toEqual({ label: "EV", value: "N/M", detail: "for banks" });
  // An asset manager's EV stays; a financial company the source gave no EV for shows no line, as before.
  expect(withFinancialEnterpriseValue(served, { industry: "Asset Management" })).toBe(served);
  const none: Fundamentals = { marketCap: 760e9 };
  expect(withFinancialEnterpriseValue(none, { industry: "Insurance - Life" })).toBe(none);
  expect(stat(none)).toBeUndefined();
});
