import { describe, expect, test } from "bun:test";
import type { PsdBalanceRow, PsdBoardPayload } from "../../../api-client/commodity-balances";
import type { HeadlessBundleResult, HeadlessPaneContext } from "../../../types/plugin";
import { commodityBalancesHeadless } from "./headless";
import { psdCrop } from "./model";

const row = (crop: string, country: string, attribute: string, value: number, month: string | null, cropOrder: number): PsdBalanceRow => ({
  id: `${crop}|${country}|${attribute}`, crop, country, attribute, value,
  unit: crop === "Coffee" ? "1000 60 kg bags" : "1000 MT", year: "2026/27", month, cropOrder, countryOrder: 0, attributeOrder: 0,
});

const board: PsdBoardPayload = {
  source: "USDA",
  status: "partial",
  checkedAt: "2026-10-16T06:00:00.000Z",
  stale: false,
  gaps: ["Soybean balances are unavailable.", "Price forecasts have not refreshed since 1 Oct 2026."],
  month: "2026-10",
  marketYear: "2026/27",
  rows: [
    row("Wheat", "China", "Production", 141000, "2026-10", 0),
    row("Coffee", "Brazil", "Production", 71900, "2026-07", 4),
    row("Sugar", "Brazil", "Production", 42500, "2026-05", 5),
  ],
  prices: [{ id: "Wheat|2026/27", crop: "Wheat", forecast: 6.59, unit: "$/bu", season: "2026/27", cropOrder: 0, seasonYear: 2026 }],
  pricesDate: "2026-10-01",
};

async function load(argument: string | null, payload = board) {
  const apiClient = { getCloudPsdBoard: async () => payload };
  return await commodityBalancesHeadless.load(
    { rawArgument: argument ?? "", argument, symbols: [], options: {} },
    { apiClient, signal: new AbortController().signal } as unknown as HeadlessPaneContext,
  ) as HeadlessBundleResult;
}

describe("PSD report", () => {
  test("a crop narrows the board to its rows, dated by its own estimates and with only its gaps", async () => {
    const coffee = await load("coffee");
    expect(coffee.sections.map((section) => section.title)).toEqual(["Coffee balances 2026/27"]);
    expect(coffee.sections[0]!.rows).toEqual([
      { crop: "Coffee", country: "Brazil", attribute: "Production", value: 71900, unit: "1000 60 kg bags", year: "2026/27" },
    ]);
    // July's coffee estimates are not October's WASDE.
    expect(coffee.metadata).toMatchObject({ asOf: "2026-07-01", month: "2026-07", priced: false });
    expect(coffee.notes).toEqual(["Price forecasts have not refreshed since 1 Oct 2026."]);

    const all = await load(null);
    expect(all.sections.map((section) => section.title)).toEqual(["Balances 2026/27", "Prices"]);
    expect(all.metadata).toMatchObject({ asOf: "2026-10-01" });
    expect(all.notes).toHaveLength(2);
  });

  test("an unknown crop names the ones there are; a crop the server does not serve yet says so", async () => {
    await expect(load("rice")).rejects.toThrow('No crop "rice". PSD covers wheat, corn, soybeans, cotton, coffee and sugar.');
    await expect(load("sugar", { ...board, rows: board.rows.filter((entry) => entry.crop !== "Sugar") }))
      .rejects.toThrow("Sugar balances are not available yet.");
    expect([psdCrop("Soybean"), psdCrop("soy"), psdCrop("COT"), psdCrop("co")]).toEqual(["Soybeans", "Soybeans", "Cotton", null]);
  });
});
