import { signalWithTimeout } from "../../../utils/async-deadline";
import { httpFetch } from "../../../utils/http-transport";
import { readZipTexts } from "../shared/zip-text";
import {
  balanceAttribute,
  balanceBoard,
  boardMarketYear,
  cleanUnit,
  cropForCode,
  marketYearLabel,
  priceCrop,
  priceUnit,
  type BalanceRecord,
  type PriceForecast,
} from "./model";

const BALANCE_ZIPS = [
  "https://apps.fas.usda.gov/psdonline/downloads/psd_grains_pulses_csv.zip",
  "https://apps.fas.usda.gov/psdonline/downloads/psd_oilseeds_csv.zip",
  "https://apps.fas.usda.gov/psdonline/downloads/psd_cotton_csv.zip",
] as const;

const PRICE_URL = "https://www.ers.usda.gov/media/6497/output-forecast-csv-file.csv";
const FETCH_TIMEOUT_MS = 60_000;
const TRACKED_CODE = /^(?:0410000|0440000|2222000|2631000),/;

export interface CommodityBalances {
  rows: ReturnType<typeof balanceBoard>;
  prices: PriceForecast[];
  marketYear: string | null;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function columnIndex(header: readonly string[], name: string): number {
  const index = header.indexOf(name);
  if (index < 0) throw new Error("Balance file format was not recognized");
  return index;
}

function optionalColumn(header: readonly string[], name: string): number {
  return header.indexOf(name);
}

export function parseBalanceCsv(text: string): BalanceRecord[] {
  const source = text.replace(/^\uFEFF/, "");
  const headerEnd = source.indexOf("\n");
  const headerLine = (headerEnd === -1 ? source : source.slice(0, headerEnd)).replace(/\r$/, "");
  const header = splitCsvLine(headerLine).map((field) => field.trim());
  const codeIndex = columnIndex(header, "Commodity_Code");
  const countryCodeIndex = columnIndex(header, "Country_Code");
  const countryIndex = columnIndex(header, "Country_Name");
  const yearIndex = columnIndex(header, "Market_Year");
  const attributeIndex = columnIndex(header, "Attribute_Description");
  const unitIndex = columnIndex(header, "Unit_Description");
  const valueIndex = columnIndex(header, "Value");
  const records: BalanceRecord[] = [];
  let start = headerEnd === -1 ? source.length : headerEnd + 1;
  while (start < source.length) {
    const end = source.indexOf("\n", start);
    const next = end === -1 ? source.length : end;
    let line = source.slice(start, next);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = next + 1;
    if (!TRACKED_CODE.test(line)) continue;
    const fields = splitCsvLine(line);
    const crop = cropForCode(fields[codeIndex] ?? "");
    const attribute = balanceAttribute(fields[attributeIndex] ?? "");
    const marketYear = Number(fields[yearIndex]);
    const value = Number(fields[valueIndex]);
    const country = (fields[countryIndex] ?? "").trim();
    if (!crop || !attribute || !country || !Number.isInteger(marketYear) || !Number.isFinite(value)) continue;
    records.push({
      crop,
      countryCode: (fields[countryCodeIndex] ?? "").trim(),
      country,
      marketYear,
      attribute,
      unit: cleanUnit(fields[unitIndex] ?? ""),
      value,
    });
  }
  return records;
}

export function parsePriceForecasts(text: string): PriceForecast[] {
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source || source.startsWith("<")) return [];
  const headerEnd = source.indexOf("\n");
  const headerLine = (headerEnd === -1 ? source : source.slice(0, headerEnd)).replace(/\r$/, "");
  const header = splitCsvLine(headerLine).map((field) => field.trim());
  const dateIndex = optionalColumn(header, "model_forecast_date");
  const cropIndex = optionalColumn(header, "commodity");
  const yearIndex = optionalColumn(header, "marketing_year");
  const forecastIndex = optionalColumn(header, "MYA_price_model_forecast");
  const unitIndex = optionalColumn(header, "price_unit");
  if (dateIndex < 0 || cropIndex < 0 || yearIndex < 0 || forecastIndex < 0 || unitIndex < 0) return [];

  const parsed: Array<PriceForecast & { date: string }> = [];
  let latest = "";
  let start = headerEnd === -1 ? source.length : headerEnd + 1;
  while (start < source.length) {
    const end = source.indexOf("\n", start);
    const next = end === -1 ? source.length : end;
    let line = source.slice(start, next);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = next + 1;
    if (!line) continue;
    const fields = splitCsvLine(line);
    const date = (fields[dateIndex] ?? "").trim();
    const crop = priceCrop(fields[cropIndex] ?? "");
    const seasonYear = Number(fields[yearIndex]);
    const forecast = Number(fields[forecastIndex]);
    if (!crop || !date || !Number.isInteger(seasonYear) || !Number.isFinite(forecast)) continue;
    if (date > latest) latest = date;
    const season = marketYearLabel(seasonYear);
    parsed.push({
      date,
      id: `${crop}|${season}`,
      crop,
      forecast,
      unit: priceUnit(fields[unitIndex] ?? ""),
      season,
      cropOrder: crop === "Wheat" ? 0 : crop === "Corn" ? 1 : crop === "Soybeans" ? 2 : 3,
      seasonYear,
    });
  }

  const seen = new Set<string>();
  const rows: PriceForecast[] = [];
  for (const row of parsed) {
    if (row.date !== latest || seen.has(row.id)) continue;
    seen.add(row.id);
    const { date: _date, ...forecast } = row;
    rows.push(forecast);
  }
  rows.sort((left, right) => left.cropOrder - right.cropOrder || left.seasonYear - right.seasonYear);
  return rows;
}

async function fetchBytes(url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const response = await httpFetch(url, {
    headers: { Accept: "*/*", "User-Agent": "gloomberb" },
    signal: signalWithTimeout(signal, FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Balance file request failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function csvFromZip(bytes: Uint8Array): Promise<string> {
  const csv = (await readZipTexts(bytes)).find((entry) => entry.name.toLowerCase().endsWith(".csv"));
  if (!csv) throw new Error("Balance file had no table");
  return csv.text;
}

async function fetchPriceText(signal: AbortSignal | undefined): Promise<string> {
  try {
    const response = await httpFetch(PRICE_URL, {
      headers: { Accept: "*/*", "User-Agent": "gloomberb" },
      signal: signalWithTimeout(signal, FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return "";
    const text = await response.text();
    return text.trimStart().startsWith("<") ? "" : text;
  } catch {
    return "";
  }
}

export async function fetchCommodityBalances(signal?: AbortSignal): Promise<CommodityBalances> {
  const [groups, prices] = await Promise.all([
    Promise.all(BALANCE_ZIPS.map(async (url) => parseBalanceCsv(await csvFromZip(await fetchBytes(url, signal))))),
    fetchPriceText(signal),
  ]);
  const rows = balanceBoard(groups.flat());
  if (rows.length === 0) throw new Error("Balance file had no rows");
  return { rows, prices: parsePriceForecasts(prices), marketYear: boardMarketYear(rows) };
}
