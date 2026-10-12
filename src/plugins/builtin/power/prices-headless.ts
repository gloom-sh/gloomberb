import { apiClient } from "../../../api-client";
import type { CarbonBoard, EuropePowerBoard, GasStorageBoard, GasStorageRow, PowerPriceRow } from "../../../api-client/europe-energy";
import type { HeadlessBundleResult, HeadlessBundleSection, HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchGasHistory, fetchGasStorage } from "./gas-client";
import { formatGasFlow, formatGasFull, formatGasPoints, formatGasTwh, gasRangePosition, parseGasQuery, type GasStorageArea } from "./gas-model";
import { fetchCarbonPrice, fetchPowerPriceHistory, fetchPowerPrices } from "./prices-client";
import {
  CARBON_PRICE_UNIT, formatPowerChange, formatPowerPrice, isCarbonQuery, POWER_PRICE_UNIT, powerPriceMarket, powerRangePosition,
} from "./prices-model";

type PricesClient = Pick<typeof apiClient, "getCloudEuropePower" | "getCloudEuropePowerHistory" | "getCloudEuropeCarbon"
  | "getCloudEuropeGas" | "getCloudEuropeGasHistory">;

const price = (value: unknown) => typeof value === "number" ? formatPowerPrice(value) : "--";
const text = (value: unknown) => typeof value === "string" && value ? value : "--";

/** A board's columns, in its words: prices to the cent in the board's unit, each row dated by its own day. */
const boardColumns = (unit: string, label = "Market"): HeadlessPaneColumn[] => [
  { key: "market", header: label },
  { key: "date", header: "As of", format: text, shrink: false },
  { key: "price", header: unit, align: "right", format: price },
  { key: "change", header: "1D", align: "right", format: (value) => typeof value === "number" ? formatPowerChange(value) : "--" },
  { key: "average7", header: "7D avg", align: "right", format: price },
  { key: "average30", header: "30D avg", align: "right", format: price },
  { key: "yearAgo", header: "1Y ago", align: "right", format: price },
  { key: "low52w", header: "52W low", align: "right", format: price },
  { key: "high52w", header: "52W high", align: "right", format: price },
  { key: "range", header: "In 1Y range", align: "right", format: (value) => typeof value === "number" ? `${value}%` : "--" },
];
const COLUMNS = boardColumns(POWER_PRICE_UNIT);
const AUCTION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "date", header: "Date", shrink: false },
  { key: "zone", header: "Zone", format: text },
  { key: "status", header: "Status" },
  { key: "price", header: CARBON_PRICE_UNIT, align: "right", format: price },
  { key: "volume", header: "Volume tCO2", align: "right", format: (value) => typeof value === "number" ? value.toLocaleString("en-US") : "--" },
  { key: "coverRatio", header: "Cover", align: "right", format: (value) => typeof value === "number" ? `${value.toFixed(2)}x` : "--" },
  { key: "bidders", header: "Bidders", align: "right", format: (value) => typeof value === "number" ? String(value) : "--" },
];

function reportRow(row: Omit<PowerPriceRow, "code"> & { code: string }) {
  const { trail: _trail, name, ...figures } = row;
  return { market: name, ...figures, range: powerRangePosition(row as PowerPriceRow) };
}

/** The EUA as of its latest auction day, then its latest general-allowance auctions. */
function carbonSections(carbon: CarbonBoard): HeadlessBundleSection[] {
  const { volume: _volume, auctions: _auctions, ...row } = carbon.row;
  return [
    { title: `EU carbon allowance (EUA) auction price, ${CARBON_PRICE_UNIT}`, columns: boardColumns(CARBON_PRICE_UNIT, "Allowance"), rows: [reportRow(row)] },
    { title: "Latest EUA auctions", columns: AUCTION_COLUMNS,
      rows: carbon.auctions.filter((auction) => !auction.aviation).map(({ aviation: _aviation, ...auction }) => ({ ...auction })) },
  ];
}

/**
 * The delivery day most markets have reached: the median market's latest
 * day. A few markets publish ahead of the rest (Ireland the day before, most
 * of the continent four days behind), so the freshest one would understate
 * how far behind the board is.
 */
function typicalPowerDate(rows: readonly Pick<PowerPriceRow, "date">[]): string | null {
  const dates = rows.flatMap((row) => row.date ? [row.date] : []).sort();
  return dates[Math.floor((dates.length - 1) / 2)] ?? null;
}

/**
 * One short line, the same in the report, the pane and a capture: the board
 * is dated by the day most markets have reached and lags from it (`most
 * markets 2026-10-07 · lag 4 days`); one market by its own delivery day; the
 * EUA alone by its last auction.
 */
function freshness(board: EuropePowerBoard | null, carbon: CarbonBoard | null, market?: PowerPriceRow): HeadlessBundleResult["freshness"] {
  const asOf = market ? market.date : board ? typicalPowerDate(board.rows) : carbon?.row.date ?? null;
  return {
    source: [board?.source.name, carbon?.source.name].filter(Boolean).join(", "),
    asOf, oldest: null,
    observation: market ? "delivery day" : board ? "most markets" : "last auction",
    status: "not-a-feed", observedKey: "date", basis: board ? "day-ahead auction" : "primary auction", dataset: true,
  };
}

const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

const number = (format: (value: number | null) => string) => (value: unknown) => typeof value === "number" ? format(value) : "--";
const GAS_COLUMNS: HeadlessPaneColumn[] = [
  { key: "area", header: "Area" },
  { key: "gasDay", header: "Gas day", format: text, shrink: false },
  { key: "status", header: "Status", format: text },
  { key: "full", header: "% full", align: "right", format: number(formatGasFull) },
  { key: "change", header: "1D pp", align: "right", format: number(formatGasPoints) },
  { key: "gasInStorage", header: "TWh", align: "right", format: number(formatGasTwh) },
  { key: "injection", header: "Inj GWh/d", align: "right", format: number(formatGasFlow) },
  { key: "withdrawal", header: "Wdr GWh/d", align: "right", format: number(formatGasFlow) },
  { key: "vsYearAgo", header: "Vs 1Y pp", align: "right", format: number(formatGasPoints) },
  { key: "fiveYearLow", header: "5Y low", align: "right", format: number(formatGasFull) },
  { key: "fiveYearAverage", header: "5Y avg", align: "right", format: number(formatGasFull) },
  { key: "fiveYearHigh", header: "5Y high", align: "right", format: number(formatGasFull) },
  { key: "fiveYearYears", header: "5Y years", align: "right", format: (value) => typeof value === "number" ? String(value) : "--" },
  { key: "range", header: "In 5Y range", align: "right", format: text },
];

function gasReportRow(row: GasStorageRow) {
  return {
    area: row.name, code: row.code, gasDay: row.gasDay, status: row.status, full: row.full, change: row.change,
    gasInStorage: row.gasInStorage, workingGasVolume: row.workingGasVolume, injection: row.injection, withdrawal: row.withdrawal,
    yearAgo: row.yearAgo?.full ?? null, yearAgoGasDay: row.yearAgo?.gasDay ?? null, vsYearAgo: row.yearAgo?.change ?? null,
    fiveYearLow: row.fiveYear?.min ?? null, fiveYearAverage: row.fiveYear?.average ?? null, fiveYearHigh: row.fiveYear?.max ?? null,
    fiveYearYears: row.fiveYear?.years.length ?? null, range: gasRangePosition(row).text,
  };
}

function gasFreshness(board: GasStorageBoard, area: GasStorageArea): HeadlessBundleResult["freshness"] {
  return {
    source: board.source.name, asOf: board.rows.find((row) => row.code === area.code)?.gasDay ?? null, oldest: null,
    observation: area.code === "EU" ? "EU gas day" : "gas day", status: "not-a-feed", observedKey: "gasDay", basis: "daily storage report", dataset: true,
  };
}

/** Every area's latest gas day; one area's figures and its last 30 gas days when one is named. */
async function loadGasStorageReport(area: GasStorageArea, named: boolean, client: PricesClient): Promise<HeadlessBundleResult> {
  const board = await fetchGasStorage(client);
  const metadata = { units: board.units, source: board.source, checkedAt: board.checkedAt, series: `CAP:gas-storage:${area.code.toLowerCase()}` };
  if (!named) {
    return { sections: [{ title: "European gas storage", columns: GAS_COLUMNS, rows: board.rows.map(gasReportRow) }],
      notes: [...board.gaps], freshness: gasFreshness(board, area), metadata };
  }
  const row = board.rows.find((entry) => entry.code === area.code);
  if (!row?.gasDay) throw new Error(`No gas storage figures for ${area.name} yet.`);
  const history = await fetchGasHistory(area.code, null, client);
  return {
    sections: [
      { title: `${area.name} gas storage`, columns: GAS_COLUMNS, rows: [gasReportRow(row)] },
      { title: `${area.name}, last 30 gas days`,
        columns: [{ key: "date", header: "Gas day", shrink: false }, { key: "status", header: "Status" },
          { key: "full", header: "% full", align: "right", format: number(formatGasFull) },
          { key: "gasInStorage", header: "TWh", align: "right", format: number(formatGasTwh) },
          { key: "injection", header: "Inj GWh/d", align: "right", format: number(formatGasFlow) },
          { key: "withdrawal", header: "Wdr GWh/d", align: "right", format: number(formatGasFlow) }],
        rows: history.points.slice(-30).reverse().map((point) => ({ ...point })) },
    ],
    notes: [...board.gaps], freshness: gasFreshness(board, area), metadata: { ...metadata, row },
  };
}

/**
 * Every market's latest day-ahead price and the EUA auction price; one
 * market's figures and its last 30 delivery days when a market is named; the
 * EUA and its latest auctions for EUA (or carbon).
 */
export async function loadPowerPricesReport(argument: string | undefined, client: PricesClient = apiClient): Promise<HeadlessBundleResult> {
  const gas = parseGasQuery(argument);
  if (gas) return loadGasStorageReport(gas.area, gas.named, client);
  if (isCarbonQuery(argument)) {
    const carbon = await fetchCarbonPrice(client);
    return { sections: carbonSections(carbon), notes: [...carbon.gaps], freshness: freshness(null, carbon),
      metadata: { market: carbon.market, unit: carbon.unit, source: carbon.source, publishedAt: carbon.publishedAt, series: "CAP:carbon:eua" } };
  }
  const board = await fetchPowerPrices(client);
  const notes = [...board.gaps];
  if (argument?.trim()) {
    const market = powerPriceMarket(argument);
    const row = market ? board.rows.find((entry) => entry.code === market.code) : null;
    if (!market || !row) throw new Error(`No day-ahead price for "${argument.trim()}". Use a market such as DE, FR, GB or Spain, EUA, or GAS for gas storage.`);
    const history = await fetchPowerPriceHistory(market.code, null, client);
    return {
      sections: [
        { title: `${market.name} day-ahead power, ${POWER_PRICE_UNIT}`, columns: COLUMNS, rows: [reportRow(row)] },
        { title: `${market.name}, last 30 delivery days`,
          columns: [{ key: "date", header: "Date", shrink: false }, { key: "price", header: POWER_PRICE_UNIT, align: "right", format: price }],
          rows: history.points.slice(-30).reverse().map((point) => ({ date: point.date, price: point.value })) },
      ],
      notes, freshness: freshness(board, null, row),
      metadata: { market: board.market, unit: board.unit, source: board.source, publishedAt: board.publishedAt, row, series: `CAP:day-ahead:${market.code.toLowerCase()}` },
    };
  }
  // The carbon allowance rides along; when it cannot load, the power board still reports and says so.
  const carbon = await fetchCarbonPrice(client).catch((error: unknown) => failure(error));
  return {
    sections: [{ title: `Day-ahead power, ${POWER_PRICE_UNIT}`, columns: COLUMNS, rows: board.rows.map(reportRow) },
      ...(typeof carbon === "string" ? [] : carbonSections(carbon))],
    notes: [...notes, ...(typeof carbon === "string" ? [carbon] : carbon.gaps)],
    freshness: freshness(board, typeof carbon === "string" ? null : carbon),
    metadata: { market: board.market, unit: board.unit, source: board.source, publishedAt: board.publishedAt,
      ...(typeof carbon === "string" ? {} : { carbon: { market: carbon.market, unit: carbon.unit, source: carbon.source, publishedAt: carbon.publishedAt } }) },
  };
}

export const powerPricesHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "free-text", optional: true, placeholder: "market", description: "A market such as DE, FR, GB or Spain, EUA for the carbon auctions, or GAS [EU|DE|...] for gas storage; omit for every market and the EUA." },
  options: [],
  freshness: { source: "Ember", status: "not-a-feed", basis: "day-ahead auction", dataset: true },
  discovery: { aliases: ["EPWR"], dataRequirements: ["Gloom Cloud European power, carbon and gas storage figures"],
    limitations: ["Daily averages of the day-ahead auction, weighted by load, per country; not intraday or forward prices",
      "Each market is dated by its own latest delivery day: continental markets usually trail by a few days",
      "The EUA price is the primary auction clearing price on business days, volume-weighted across a day's auctions; not a futures settlement",
      "Gas storage is as of each area's latest gas day; the current day is an estimate until operators confirm it",
      "Five-year ranges read the same calendar day in the five years before the gas day's own, fewer where history is short"] },
  describe: "European day-ahead power prices by country (EUR/MWh), the EU carbon allowance auction price (EUR/tCO2) and European gas storage (% full, TWh, GWh/day)",
  async load(args, ctx) {
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? undefined;
    return loadPowerPricesReport(argument, ctx.apiClient);
  },
};
