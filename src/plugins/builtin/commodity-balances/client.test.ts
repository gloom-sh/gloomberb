import { describe, expect, test } from "bun:test";
import { parseBalanceCsv, parsePriceForecasts } from "./client";
import { balanceBoard, boardMarketYear } from "./model";

const BALANCE_CSV = [
  "Commodity_Code,Commodity_Description,Country_Code,Country_Name,Market_Year,Calendar_Year,Month,Attribute_ID,Attribute_Description,Unit_ID,Unit_Description,Value",
  "0410000,\"Wheat\",US,\"United States\",2024,2026,10,028,\"Production\",4,\"(1000 MT)\",50000",
  "0410000,\"Wheat\",KS,\"Korea, South\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",1",
  "0410000,\"Wheat\",US,\"United States\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",40000",
  "0410000,\"Wheat\",CH,\"China\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",140000",
  "0410000,\"Wheat\",RS,\"Russia\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",90000",
  "0410000,\"Wheat\",00,\"World\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",1000",
  "0410000,\"Wheat\",US,\"United States\",2025,2026,10,125,\"Domestic Consumption\",4,\"(1000 MT)\",30000",
  "0410000,\"Wheat\",CH,\"China\",2025,2026,10,125,\"Domestic Consumption\",4,\"(1000 MT)\",120000",
  "0410000,\"Wheat\",RS,\"Russia\",2025,2026,10,125,\"Domestic Consumption\",4,\"(1000 MT)\",40000",
  "0410000,\"Wheat\",00,\"World\",2025,2026,10,125,\"Domestic Consumption\",4,\"(1000 MT)\",700",
  "0410000,\"Wheat\",US,\"United States\",2025,2026,10,088,\"Exports\",4,\"(1000 MT)\",22000.5",
  "0410000,\"Wheat\",CH,\"China\",2025,2026,10,088,\"Exports\",4,\"(1000 MT)\",1000",
  "0410000,\"Wheat\",RS,\"Russia\",2025,2026,10,088,\"Exports\",4,\"(1000 MT)\",50000",
  "0410000,\"Wheat\",00,\"World\",2025,2026,10,088,\"Exports\",4,\"(1000 MT)\",200",
  "0410000,\"Wheat\",US,\"United States\",2025,2026,10,176,\"Ending Stocks\",4,\"(1000 MT)\",15000",
  "0410000,\"Wheat\",CH,\"China\",2025,2026,10,176,\"Ending Stocks\",4,\"(1000 MT)\",10000",
  "0410000,\"Wheat\",RS,\"Russia\",2025,2026,10,176,\"Ending Stocks\",4,\"(1000 MT)\",8000",
  "0410000,\"Wheat\",00,\"World\",2025,2026,10,176,\"Ending Stocks\",4,\"(1000 MT)\",500",
  "0410000,\"Wheat\",US,\"United States\",2025,2026,10,057,\"Imports\",4,\"(1000 MT)\",3000",
  "0440000,\"Corn\",BR,\"Brazil\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",130000",
  "0440000,\"Corn\",BR,\"Brazil\",2025,2026,10,125,\"Domestic Consumption\",4,\"(1000 MT)\",80000",
  "0440000,\"Corn\",BR,\"Brazil\",2025,2026,10,088,\"Exports\",4,\"(1000 MT)\",40000",
  "0440000,\"Corn\",BR,\"Brazil\",2025,2026,10,176,\"Ending Stocks\",4,\"(1000 MT)\",10000",
  "2222000,\"Oilseed, Soybean\",AR,\"Argentina\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",50000",
  "2222000,\"Oilseed, Soybean\",AR,\"Argentina\",2025,2026,10,125,\"Domestic Consumption\",4,\"(1000 MT)\",40000",
  "2222000,\"Oilseed, Soybean\",AR,\"Argentina\",2025,2026,10,088,\"Exports\",4,\"(1000 MT)\",5000",
  "2222000,\"Oilseed, Soybean\",AR,\"Argentina\",2025,2026,10,176,\"Ending Stocks\",4,\"(1000 MT)\",2000",
  "2631000,\"Cotton\",IN,\"India\",2025,2026,10,028,\"Production\",27,\"1000 480 lb. Bales\",24000",
  "2631000,\"Cotton\",IN,\"India\",2025,2026,10,142,\"Domestic Use\",27,\"1000 480 lb. Bales\",20000",
  "2631000,\"Cotton\",IN,\"India\",2025,2026,10,088,\"Exports\",27,\"1000 480 lb. Bales\",2000",
  "2631000,\"Cotton\",IN,\"India\",2025,2026,10,176,\"Ending Stocks\",27,\"1000 480 lb. Bales\",1000",
  "0813100,\"Meal, Soybean\",AR,\"Argentina\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",999",
  "0430000,\"Barley\",US,\"United States\",2025,2026,10,028,\"Production\",4,\"(1000 MT)\",999",
].join("\n");

const PRICE_CSV = [
  "model_forecast_date,commodity,marketing_year,MYA_price_model_forecast,MYA_price_WASDE_forecast,price_unit",
  "2026-08-01,Corn,2026,4.1,4.0,U.S. dollars per bushel",
  "2026-09-03,Corn,2025,4.224539,4.15,U.S. dollars per bushel",
  "2026-09-03,Corn,2026,5.390021,4.5,U.S. dollars per bushel",
  "2026-09-03,Corn,2027,NA,NA,U.S. dollars per bushel",
  "2026-09-03,Wheat,2026,7.159639,6.2,U.S. dollars per bushel",
  "2026-09-03,Cotton,2026,0.821634,0.75,U.S. dollars per pound",
  "2026-09-03,Soybeans,2026,12.846656,11.4,U.S. dollars per bushel",
  "2026-09-03,Rice,2026,9,9,U.S. dollars per bushel",
].join("\n");

describe("crop balance parsing", () => {
  test("reads quoted names, units and the four balance attributes", () => {
    const records = parseBalanceCsv(BALANCE_CSV);
    expect(records.some((row) => row.country === "Korea, South" && row.value === 1)).toBe(true);
    expect(records.some((row) => row.crop === "Soybeans" && row.country === "Argentina")).toBe(true);
    expect(records.some((row) => row.attribute === "Imports" || row.crop === "Barley")).toBe(false);
    const cotton = records.find((row) => row.crop === "Cotton" && row.attribute === "Domestic use");
    expect(cotton).toMatchObject({ unit: "1000 480 lb. Bales", value: 20000, marketYear: 2025 });
    const wheatUse = records.find((row) => row.crop === "Wheat" && row.country === "China" && row.attribute === "Domestic use");
    expect(wheatUse?.value).toBe(120000);
    expect(records.find((row) => row.country === "United States" && row.attribute === "Exports")?.value).toBe(22000.5);
  });

  test("keeps the latest market year, the largest producers and a world row", () => {
    const rows = balanceBoard(parseBalanceCsv(BALANCE_CSV), 2);
    const wheat = rows.filter((row) => row.crop === "Wheat");
    expect(wheat.map((row) => row.country)).toEqual([
      "World", "World", "World", "World",
      "China", "China", "China", "China",
      "Russia", "Russia", "Russia", "Russia",
    ]);
    expect(wheat.map((row) => row.attribute)).toEqual([
      "Production", "Domestic use", "Exports", "Ending stocks",
      "Production", "Domestic use", "Exports", "Ending stocks",
      "Production", "Domestic use", "Exports", "Ending stocks",
    ]);
    expect(wheat.every((row) => row.year === "2025/26")).toBe(true);
    expect(rows.some((row) => row.country === "United States" || row.country === "Korea, South" || row.year === "2024/25")).toBe(false);
    expect(rows.filter((row) => row.crop === "Corn").map((row) => row.country)).toEqual([
      "Brazil", "Brazil", "Brazil", "Brazil",
    ]);
    expect(rows.find((row) => row.crop === "Soybeans")?.unit).toBe("1000 MT");
    expect(boardMarketYear(rows)).toBe("2025/26");
  });

  test("rejects a balance table without the expected columns", () => {
    expect(() => parseBalanceCsv("Commodity_Code,Value\n0410000,1\n")).toThrow("Balance file format was not recognized");
  });

  test("reads the latest season-average forecasts and skips a page", () => {
    expect(parsePriceForecasts("<html>not a table</html>")).toEqual([]);
    expect(parsePriceForecasts(PRICE_CSV)).toEqual([
      { id: "Wheat|2026/27", crop: "Wheat", forecast: 7.159639, unit: "$/bu", season: "2026/27", cropOrder: 0, seasonYear: 2026 },
      { id: "Corn|2025/26", crop: "Corn", forecast: 4.224539, unit: "$/bu", season: "2025/26", cropOrder: 1, seasonYear: 2025 },
      { id: "Corn|2026/27", crop: "Corn", forecast: 5.390021, unit: "$/bu", season: "2026/27", cropOrder: 1, seasonYear: 2026 },
      { id: "Soybeans|2026/27", crop: "Soybeans", forecast: 12.846656, unit: "$/bu", season: "2026/27", cropOrder: 2, seasonYear: 2026 },
      { id: "Cotton|2026/27", crop: "Cotton", forecast: 0.821634, unit: "$/lb", season: "2026/27", cropOrder: 3, seasonYear: 2026 },
    ]);
  });
});
