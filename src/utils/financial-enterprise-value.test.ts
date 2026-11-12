import { expect, test } from "bun:test";
import type { Fundamentals } from "../types/financials";
import { buildOverviewStats } from "../plugins/builtin/ticker-detail/overview/model";
import {
  BANK_ENTERPRISE_VALUE, BROKER_ENTERPRISE_VALUE, enterpriseValueReconciliationNote, financialEnterpriseValue, financialEnterpriseValueReason,
  INSURER_ENTERPRISE_VALUE, withFinancialEnterpriseValue,
} from "./fundamentals";

test("a bank's, an insurer's and a broker's EV is not meaningful; an asset manager's, an exchange's and an insurance broker's is", () => {
  expect(["Banks - Diversified", "Banks - Regional"].map(financialEnterpriseValueReason)).toEqual([BANK_ENTERPRISE_VALUE, BANK_ENTERPRISE_VALUE]);
  expect(["Insurance - Life", "Insurance - Property & Casualty", "Insurance - Diversified", "Insurance - Reinsurance", "Insurance - Specialty"]
    .map(financialEnterpriseValueReason)).toEqual(Array(5).fill(INSURER_ENTERPRISE_VALUE));
  expect(financialEnterpriseValueReason("Capital Markets")).toBe(BROKER_ENTERPRISE_VALUE);
  expect(["Asset Management", "Financial Data & Stock Exchanges", "Insurance Brokers", "Credit Services", "Software - Infrastructure", null]
    .map(financialEnterpriseValueReason)).toEqual(Array(6).fill(null));
});

const stat = (fundamentals: Fundamentals | undefined) => buildOverviewStats({
  quote: undefined, fundamentals, quoteCurrency: "HKD", baseCurrency: "USD", toBase: (value) => value,
}).find((entry) => entry.label === "EV");

test("DES: AIA's EV reads N/M for insurers where it read a dash, HSBC's N/M for banks, China Securities' N/M for brokers", () => {
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
  const broker = withFinancialEnterpriseValue(served, { industry: "Capital Markets" });
  expect(stat(broker)).toEqual({ label: "EV", value: "N/M", detail: "for brokers" });
  expect(broker.enterpriseToRevenue).toBeUndefined();
  // An asset manager's EV stays; a financial company the source gave no EV for shows no line, as before.
  expect(withFinancialEnterpriseValue(served, { industry: "Asset Management" })).toBe(served);
  const none: Fundamentals = { marketCap: 760e9 };
  expect(withFinancialEnterpriseValue(none, { industry: "Insurance - Life" })).toBe(none);
  expect(stat(none)).toBeUndefined();
});
