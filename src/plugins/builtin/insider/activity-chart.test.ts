import { expect, test } from "bun:test";
import type { SecFilingItem } from "../../../types/data-provider";
import { parseInsiderFiling } from "./model";
import { insiderActivitySeries, insiderPlanShare, insiderWeeklyActivity } from "./activity-chart";

function filing(accessionNumber: string): SecFilingItem {
  return { accessionNumber, form: "4", filingDate: new Date("2026-11-20T00:00:00Z"), cik: "1", filingUrl: `https://www.sec.gov/${accessionNumber}` };
}

function form4(code: string, shares: number, date: string, { plan = false, derivative = false } = {}) {
  const tag = derivative ? "derivativeTransaction" : "nonDerivativeTransaction";
  return `<ownershipDocument><documentType>4</documentType><reportingOwner><reportingOwnerId><rptOwnerCik>1</rptOwnerCik><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId></reportingOwner><aff10b5One>${plan ? 1 : 0}</aff10b5One><${tag}><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>${date}</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts></${tag}></ownershipDocument>`;
}

const palette = { buy: "#0f0", planBuy: "#070", sell: "#f00", planSell: "#700", price: "#fff" };

test("open-market trades add up by the week they traded, plan trades apart, awards and options left out", () => {
  const parsed = [
    // Monday 16 Nov and Sunday 22 Nov 2026 are one week; Monday 23 Nov starts the next.
    ...parseInsiderFiling(filing("a"), form4("S", 1000, "2026-11-16", { plan: true })),
    ...parseInsiderFiling(filing("b"), form4("S", 500, "2026-11-22")),
    ...parseInsiderFiling(filing("c"), form4("P", 200, "2026-11-18")),
    ...parseInsiderFiling(filing("d"), form4("S", 300, "2026-11-23", { plan: true })),
    ...parseInsiderFiling(filing("award"), form4("A", 9000, "2026-11-17")),
    ...parseInsiderFiling(filing("option"), form4("S", 7000, "2026-11-17", { derivative: true })),
    ...parseInsiderFiling(filing("loading"), null, true),
  ];
  const weeks = insiderWeeklyActivity(parsed);
  expect(weeks).toEqual([
    { start: "2026-11-16", buys: 200, planBuys: 0, sales: 500, planSales: 1000 },
    { start: "2026-11-23", buys: 0, planBuys: 0, sales: 0, planSales: 300 },
  ]);
  expect(insiderPlanShare(weeks, "sell")).toEqual({ plan: 1300, total: 1800 });
  // `since` keeps the 90 days the figures count.
  expect(insiderWeeklyActivity(parsed, Date.parse("2026-11-20T00:00:00Z")).map((week) => week.start)).toEqual(["2026-11-16", "2026-11-23"]);
  expect(insiderWeeklyActivity(parsed, Date.parse("2026-11-23T00:00:00Z"))).toEqual([{ start: "2026-11-23", buys: 0, planBuys: 0, sales: 0, planSales: 300 }]);

  // Buys above zero, sales below it, a quiet week at zero, and the close on its own axis from the first week.
  const prices = ["2026-11-10", "2026-11-16", "2026-11-23"].map((day, index) => ({ date: new Date(`${day}T00:00:00Z`), close: 100 + index }));
  const series = insiderActivitySeries(weeks, prices, palette);
  expect(series.map((entry) => entry.id)).toEqual(["buys", "sales", "plan-sales", "price"]);
  const values = (id: string) => series.find((entry) => entry.id === id)!.points.map((point) => point.value);
  expect(values("buys")).toEqual([200, 0]);
  // A week with no trade between two that had one is a week at zero, so the bars stay a week wide.
  const gap = insiderActivitySeries([weeks[0]!, { ...weeks[1]!, start: "2026-11-30" }], null, palette);
  expect(gap.find((entry) => entry.id === "plan-sales")!.points.map((point) => point.value)).toEqual([-1000, 0, -300]);
  expect(values("plan-sales")).toEqual([-1000, -300]);
  expect(values("price")).toEqual([101, 102]);
  expect(series.map((entry) => entry.axis)).toEqual(["left", "left", "left", "right"]);
  // Closes that crossed a JSON boundary carry ISO strings, as on the desktop and the web.
  const sent = JSON.parse(JSON.stringify(prices)) as typeof prices;
  expect(insiderActivitySeries(weeks, sent, palette).find((entry) => entry.id === "price")!.points.map((point) => point.value)).toEqual([101, 102]);
  // One week and no price is no chart: the figures already say it.
  expect(insiderActivitySeries(weeks.slice(0, 1), null, palette)).toEqual([]);
  expect(insiderActivitySeries([], prices, palette)).toEqual([]);
});
