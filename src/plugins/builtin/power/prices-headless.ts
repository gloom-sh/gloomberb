import { apiClient } from "../../../api-client";
import type { EuropePowerBoard, PowerPriceRow } from "../../../api-client/europe-energy";
import type { HeadlessBundleResult, HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPowerPriceHistory, fetchPowerPrices } from "./prices-client";
import { formatPowerChange, formatPowerPrice, latestPowerDate, POWER_PRICE_UNIT, powerPriceMarket, powerRangePosition } from "./prices-model";

const price = (value: unknown) => typeof value === "number" ? formatPowerPrice(value) : "--";
const text = (value: unknown) => typeof value === "string" && value ? value : "--";

/** The board's columns, in its words: prices in EUR/MWh to the cent, each row dated by its own delivery day. */
const COLUMNS: HeadlessPaneColumn[] = [
  { key: "market", header: "Market" },
  { key: "date", header: "As of", format: text, shrink: false },
  { key: "price", header: POWER_PRICE_UNIT, align: "right", format: price },
  { key: "change", header: "1D", align: "right", format: (value) => typeof value === "number" ? formatPowerChange(value) : "--" },
  { key: "average7", header: "7D avg", align: "right", format: price },
  { key: "average30", header: "30D avg", align: "right", format: price },
  { key: "yearAgo", header: "1Y ago", align: "right", format: price },
  { key: "low52w", header: "52W low", align: "right", format: price },
  { key: "high52w", header: "52W high", align: "right", format: price },
  { key: "range", header: "In 1Y range", align: "right", format: (value) => typeof value === "number" ? `${value}%` : "--" },
];

function reportRow(row: PowerPriceRow) {
  const { trail: _trail, name, ...figures } = row;
  return { market: name, ...figures, range: powerRangePosition(row) };
}

/** Markets publish days apart: the line dates the newest and names the oldest. */
function freshness(board: EuropePowerBoard): HeadlessBundleResult["freshness"] {
  const dates = board.rows.flatMap((row) => row.date ? [row.date] : []).sort();
  return { source: board.source.name, asOf: latestPowerDate(board.rows), oldest: dates[0] ?? null, status: "not-a-feed", observedKey: "date",
    basis: "day-ahead auction", dataset: true, note: `daily averages in ${POWER_PRICE_UNIT}, ${board.source.licence}` };
}

/**
 * Every market's latest day-ahead price, or one market's figures and its last
 * 30 delivery days when a market is named.
 */
export async function loadPowerPricesReport(
  argument: string | undefined,
  client: Pick<typeof apiClient, "getCloudEuropePower" | "getCloudEuropePowerHistory"> = apiClient,
): Promise<HeadlessBundleResult> {
  const board = await fetchPowerPrices(client);
  const notes = [...board.gaps];
  if (argument?.trim()) {
    const market = powerPriceMarket(argument);
    const row = market ? board.rows.find((entry) => entry.code === market.code) : null;
    if (!market || !row) throw new Error(`No day-ahead price for "${argument.trim()}". Use a market such as DE, FR, GB or Spain.`);
    const history = await fetchPowerPriceHistory(market.code, null, client);
    return {
      sections: [
        { title: `${market.name} day-ahead power, ${POWER_PRICE_UNIT}`, columns: COLUMNS, rows: [reportRow(row)] },
        { title: `${market.name}, last 30 delivery days`,
          columns: [{ key: "date", header: "Date", shrink: false }, { key: "price", header: POWER_PRICE_UNIT, align: "right", format: price }],
          rows: history.points.slice(-30).reverse().map((point) => ({ date: point.date, price: point.value })) },
      ],
      notes, freshness: freshness(board),
      metadata: { market: board.market, unit: board.unit, source: board.source, publishedAt: board.publishedAt, row, series: `CAP:day-ahead:${market.code.toLowerCase()}` },
    };
  }
  return {
    sections: [{ title: `Day-ahead power, ${POWER_PRICE_UNIT}`, columns: COLUMNS, rows: board.rows.map(reportRow) }],
    notes, freshness: freshness(board),
    metadata: { market: board.market, unit: board.unit, source: board.source, publishedAt: board.publishedAt },
  };
}

export const powerPricesHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "free-text", optional: true, placeholder: "market", description: "A market such as DE, FR, GB or Spain; omit for every market." },
  options: [],
  freshness: { source: "Ember", status: "not-a-feed", basis: "day-ahead auction", dataset: true },
  discovery: { aliases: ["EPWR"], dataRequirements: ["Gloom Cloud European power prices"],
    limitations: ["Daily averages of the day-ahead auction, weighted by load, per country; not intraday or forward prices",
      "Each market is dated by its own latest delivery day: continental markets usually trail by a few days"] },
  describe: "European day-ahead power prices by country, EUR/MWh",
  async load(args, ctx) {
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? undefined;
    return loadPowerPricesReport(argument, ctx.apiClient);
  },
};
