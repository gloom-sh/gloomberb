import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCommodityBalances } from "./client";
import { formatBalanceValue, formatForecast } from "./model";

const amount = (value: unknown) => typeof value === "number" ? formatBalanceValue(value) : "--";
const forecast = (value: unknown) => typeof value === "number" ? formatForecast(value) : "--";

export const commodityBalancesHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "none" },
  options: [],
  discovery: {
    aliases: ["PSD"],
    dataRequirements: ["World crop balance archive", "Season-average price forecast file"],
    limitations: [
      "Latest market year only",
      "Largest producers, and the world total when the file has one",
      "Cotton is in 480 lb bales; grains and soybeans are in thousand metric tons",
    ],
  },
  describe: "Wheat, corn, soybean and cotton balances",
  freshness: { source: "USDA", status: "not-a-feed", basis: "monthly supply and demand estimates" },
  async load(_args, ctx) {
    const data = await fetchCommodityBalances(ctx.signal);
    return {
      complete: data.rows.length > 0,
      sections: [
        {
          title: data.marketYear ? `Balances ${data.marketYear}` : "Balances",
          columns: [
            { key: "crop", header: "Crop" },
            { key: "country", header: "Country" },
            { key: "attribute", header: "Attribute" },
            { key: "value", header: "Value", align: "right", format: amount },
            { key: "unit", header: "Unit" },
            { key: "year", header: "Year" },
          ],
          rows: data.rows.map((row) => ({
            crop: row.crop,
            country: row.country,
            attribute: row.attribute,
            value: row.value,
            unit: row.unit,
            year: row.year,
          })),
        },
        ...(data.prices.length === 0 ? [] : [{
          title: "Prices",
          columns: [
            { key: "crop", header: "Crop" },
            { key: "forecast", header: "Forecast", align: "right" as const, format: forecast },
            { key: "unit", header: "Unit" },
            { key: "season", header: "Season" },
          ],
          rows: data.prices.map((row) => ({
            crop: row.crop,
            forecast: row.forecast,
            unit: row.unit,
            season: row.season,
          })),
        }]),
      ],
      metadata: { marketYear: data.marketYear, priced: data.prices.length > 0 },
    };
  },
};
