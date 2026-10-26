import { describe, expect, test } from "bun:test";
import { formatCompactMoney, moneyText } from "./format";
import { normalizeCompany } from "./model/normalizers";
import { renderBuildoutCell } from "./cells";
import type { BuildoutColumn, BuildoutRow } from "./model/types";

const cellText = (row: BuildoutRow, id: BuildoutColumn["id"]) =>
  renderBuildoutCell(row, { id, label: "", width: 10, align: "right" }, { selected: false }, { favoriteBusyKey: null, toggleFavorite: () => {} });

describe("compact money", () => {
  test("a company's figures and a list's total read in the same form", () => {
    expect(moneyText("$5094.1B")).toBe("$5.1T");
    expect(moneyText("$5.1T")).toBe("$5.1T");
    expect(moneyText("$356.4B")).toBe("$356.4B");
    expect(moneyText("$-4.9B")).toBe("-$4.9B");
    expect(moneyText("$420.0M")).toBe("$420.0M");
    expect(moneyText("$0.4B")).toBe("$400.0M");
    expect(moneyText("$8.0T")).toBe("$8.0T");
    // The unit is picked after rounding.
    expect(formatCompactMoney(999_960_000_000)).toBe("$1.0T");
    expect(formatCompactMoney(-0.01e9)).toBe("-$10.0M");
    expect(formatCompactMoney(0)).toBe("$0");
    // Anything that is not a dollar figure keeps the service's own text.
    expect(moneyText("NT$61848.7B")).toBe("NT$61848.7B");
    expect(moneyText(null)).toBe("-");
  });

  test("the cells carry the whole number for an export and the same text in both tables", () => {
    const company: BuildoutRow = { kind: "company", item: { id: "1", name: "Nvidia", marketCap: "$5094.1B", revenue: "$215.9B", netIncome: "$-4.9B" } };
    const list: BuildoutRow = { kind: "list", item: { id: "l", slug: "l", name: "L", totalMarketCap: "$5.1T" } };
    expect(cellText(company, "marketCap")).toMatchObject({ text: "$5.1T", value: 5_094_100_000_000 });
    expect(cellText(company, "revenue")).toMatchObject({ text: "$215.9B", value: 215_900_000_000 });
    expect(cellText(company, "netIncome").text).toBe("-$4.9B");
    expect(cellText(list, "totalMarketCap").text).toBe(cellText(company, "marketCap").text);
  });
});

describe("a depositary receipt's statements in another currency", () => {
  // As the service sends them: the receipt names USD, and its statements are the Korean listing's won under a dollar sign.
  const receipt = {
    ticker: "SKHY", exchange: "NASDAQ", currency: "USD", marketCap: "$701.8B", stockPrice: "$139.79",
    revenue: "$97146.7B", netIncome: "$42919.3B", freeCashFlow: "$90428.6B", dilutedEps: "$6037.80", profitMargins: "44.2%",
  };

  test("leaves out the figures that cannot be dollars and keeps the ones that can", () => {
    const company = normalizeCompany(receipt);
    expect(company.revenue).toBeNull();
    expect(company.netIncome).toBeNull();
    expect(company.freeCashFlow).toBeNull();
    expect(company.dilutedEps).toBeNull();
    expect(company.marketCap).toBe("$701.8B");
    expect(company.profitMargins).toBe("44.2%");
  });

  test("never touches a row whose figures were converted or sit in a believable range", () => {
    const listing = normalizeCompany({ ...receipt, ticker: "000660", exchange: "KRX", currency: "KRW", revenue: "$77.7B", revenueOriginal: "₩97146.7B", netIncome: "$34.3B" });
    expect(listing.revenue).toBe("$77.7B");
    // A large revenue on a small market cap, as a low-margin distributor or a carmaker has.
    const carmaker = normalizeCompany({ ticker: "GM", exchange: "NYSE", currency: "USD", marketCap: "$64.5B", revenue: "$185.0B", netIncome: "$2.7B" });
    expect(carmaker.revenue).toBe("$185.0B");
    // No market cap to judge against.
    expect(normalizeCompany({ ticker: "X", currency: "USD", revenue: "$97146.7B" }).revenue).toBe("$97146.7B");
  });
});
