import { apiClient } from "../../../api-client";
import type { CloudShortInterestPayload } from "../../../api-client/types";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import { YahooHttpClient } from "../../../sources/yahoo-finance/http";
import { financeRawNumber, yahooRawDate } from "../../../sources/yahoo-finance/mappers";
import type { QuoteSummaryResponse, YahooQuoteSummaryResult } from "../../../sources/yahoo-finance/types";
import type { ShortInterestRecord } from "./types";

export const YAHOO_SHORT_INTEREST_CONNECTION_ID = "yahoo-short-interest";
const yahoo = new YahooHttpClient();

let connectionHealth: ConnectionHealthRegistry | null = null;

export function attachShortInterestHealth(health?: ConnectionHealthRegistry): void {
  connectionHealth = health ?? null;
}

export function resetShortInterestHealth(): void {
  connectionHealth = null;
}

function rawDate(value: unknown): Date | null {
  const iso = yahooRawDate(value);
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRecords(result: YahooQuoteSummaryResult): ShortInterestRecord[] {
  const stats = result.defaultKeyStatistics;
  if (!stats) return [];

  const records: ShortInterestRecord[] = [];
  const currentDate = rawDate(stats.dateShortInterest);
  const currentShares = financeRawNumber(stats.sharesShort) ?? null;
  const shortRatio = financeRawNumber(stats.shortRatio) ?? null;
  const shortPercentFloat = financeRawNumber(stats.shortPercentOfFloat) ?? null;
  const floatShares = financeRawNumber(stats.floatShares) ?? null;

  if (currentDate && currentShares != null) {
    records.push({
      settlementDate: currentDate,
      sharesShort: currentShares,
      shortRatio,
      averageDailyVolume: shortRatio != null && shortRatio > 0
        ? Math.round(currentShares / shortRatio)
        : null,
      shortPercentFloat: shortPercentFloat != null
        ? shortPercentFloat * 100
        : floatShares != null && floatShares > 0
          ? (currentShares / floatShares) * 100
          : null,
    });
  }

  const priorDate = rawDate(stats.sharesShortPreviousMonthDate);
  const priorShares = financeRawNumber(stats.sharesShortPriorMonth) ?? null;

  if (priorDate && priorShares != null) {
    records.push({
      settlementDate: priorDate,
      sharesShort: priorShares,
      shortRatio: null,
      averageDailyVolume: null,
      shortPercentFloat: floatShares != null && floatShares > 0
        ? (priorShares / floatShares) * 100
        : null,
    });
  }

  return records.sort((a, b) => a.settlementDate.getTime() - b.settlementDate.getTime());
}

async function requestShortInterest(symbol: string): Promise<ShortInterestRecord[]> {
  const params = new URLSearchParams({ modules: "defaultKeyStatistics" });
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?${params}`;
  const data = await yahoo.fetchJsonWithCrumb<QuoteSummaryResponse>(url);
  const result = data.quoteSummary?.result?.[0];
  if (!result) throw new Error(`No short interest data for ${symbol}`);
  return normalizeRecords(result);
}

function fetchYahooShortInterest(symbol: string): Promise<ShortInterestRecord[]> {
  const request = () => requestShortInterest(symbol);
  return connectionHealth?.hasSource(YAHOO_SHORT_INTEREST_CONNECTION_ID)
    ? connectionHealth.track(YAHOO_SHORT_INTEREST_CONNECTION_ID, "fetch", request)
    : request();
}

function normalizeCloudRecords(payload: CloudShortInterestPayload): ShortInterestRecord[] {
  const records: ShortInterestRecord[] = [];
  for (const point of payload.points) {
    const settlementDate = new Date(`${point.settlementDate}T00:00:00.000Z`);
    if (Number.isNaN(settlementDate.getTime())) continue;
    records.push({
      settlementDate,
      sharesShort: point.sharesShort,
      shortRatio: point.daysToCover,
      averageDailyVolume: point.averageDailyVolume,
      // FINRA publishes no float, so percent of float stays unknown rather than
      // being invented from a float measured on a different date.
      shortPercentFloat: null,
    });
  }
  return records;
}

/**
 * FINRA publishes every bi-monthly settlement, so it is the only real history.
 * Yahoo carries the current and prior settlement plus percent of float, so it
 * stays as the fallback when the cloud route is unavailable.
 */
export async function fetchShortInterest(
  symbol: string,
  cloudClient: Pick<typeof apiClient, "getCloudShortInterest"> = apiClient,
): Promise<ShortInterestRecord[]> {
  try {
    const response = await cloudClient.getCloudShortInterest(symbol);
    const records = response.status === "success" && response.data
      ? normalizeCloudRecords(response.data)
      : [];
    if (records.length > 0) return records;
  } catch {
    // Fall through to Yahoo rather than failing the pane.
  }
  return fetchYahooShortInterest(symbol);
}
