import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCommodityBalances } from "./client";
import { cropEstimateMonth, formatBalanceValue, formatForecast, PSD_CROPS, psdCrop, unknownCropMessage } from "./model";

/** USDA sets coffee and sugar twice a year, in its own reports rather than the monthly WASDE. */
const SEMIANNUAL_BASIS: Partial<Record<string, string>> = {
  Coffee: "semiannual estimates, June and December",
  Sugar: "semiannual estimates, May and November",
};

const amount = (value: unknown) => typeof value === "number" ? formatBalanceValue(value) : "--";
const forecast = (value: unknown) => typeof value === "number" ? formatForecast(value) : "--";

export const commodityBalancesHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: {
    kind: "free-text",
    optional: true,
    placeholder: "crop",
    description: "Wheat, corn, soybeans, cotton, coffee or sugar; omit for every crop.",
    examples: ["coffee", "sugar"],
  },
  options: [],
  discovery: {
    aliases: ["PSD"],
    dataRequirements: ["World crop balances", "Season-average price forecasts"],
    limitations: [
      "Latest market year only",
      "Largest producers, and the world total when the file has one",
      "Cotton is in 480 lb bales and coffee in thousand 60 kg bags; grains, soybeans and sugar are in thousand metric tons",
      "Coffee and sugar are USDA's semiannual estimates (coffee June and December, sugar May and November); price forecasts cover grains, soybeans and cotton",
    ],
  },
  describe: "Wheat, corn, soybean, cotton, coffee and sugar balances",
  freshness: { source: "USDA", status: "not-a-feed", basis: "monthly supply and demand estimates", periodicity: "monthly" },
  async load(args, ctx) {
    const typed = typeof args.argument === "string" && args.argument.trim() ? args.argument.trim() : null;
    const crop = typed ? psdCrop(typed) : null;
    if (typed && !crop) throw new Error(unknownCropMessage(typed));
    const board = await fetchCommodityBalances(ctx.signal, ctx.apiClient);
    const rows = crop ? board.rows.filter((row) => row.crop === crop) : board.rows;
    // A crop the server does not serve yet is said, not printed as an empty table.
    if (crop && rows.length === 0) throw new Error(`${crop} balances are not available yet.`);
    const prices = crop ? board.prices.filter((row) => row.crop === crop) : board.prices;
    // One crop is dated by its own estimates: coffee's are not the month's WASDE.
    const month = (crop ? cropEstimateMonth(rows) : null) ?? board.month;
    const marketYear = crop ? [...new Set(rows.map((row) => row.year))].join(" ") : board.marketYear;
    // Another crop's gap ("Soybean balances are unavailable.") is not this one's; one naming no crop stays.
    const names = (name: string, gap: string) => new RegExp(`\\b${name.replace(/s$/, "")}`, "i").test(gap);
    const gaps = crop
      ? board.gaps.filter((gap) => names(crop, gap) || !PSD_CROPS.some((name) => names(name, gap)))
      : board.gaps;
    const data = { ...board, rows, prices, month, marketYear, gaps };
    const basis = crop ? SEMIANNUAL_BASIS[crop] : undefined;
    return {
      // Coffee and sugar are not the month's supply and demand estimates.
      ...(basis ? { freshness: { basis } } : {}),
      complete: data.rows.length > 0,
      sections: [
        {
          title: `${crop ? `${crop} balances` : "Balances"}${data.marketYear ? ` ${data.marketYear}` : ""}`,
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
      metadata: {
        // The estimates' month; without it the report could only say when it was fetched.
        ...(data.month ? { asOf: `${data.month}-01`, month: data.month } : {}),
        marketYear: data.marketYear,
        priced: data.prices.length > 0,
        stale: data.stale,
      },
      ...(data.gaps.length ? { notes: data.gaps } : {}),
    };
  },
};
