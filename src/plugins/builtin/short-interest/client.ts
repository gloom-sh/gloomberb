import { apiClient } from "../../../api-client";
import type { CloudShortInterestPayload } from "../../../api-client/types";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import type { ShortInterestRecord } from "./types";

export const SHORT_INTEREST_CONNECTION_ID = "gloom-short-interest";
let connectionHealth: ConnectionHealthRegistry | null = null;
export function attachShortInterestHealth(health?: ConnectionHealthRegistry): void { connectionHealth = health ?? null; }
export function resetShortInterestHealth(): void { connectionHealth = null; }

function normalizeCloudRecords(payload: CloudShortInterestPayload): ShortInterestRecord[] {
  const records: ShortInterestRecord[] = [];
  for (const point of payload.points) {
    const settlementDate = new Date(`${point.settlementDate}T00:00:00.000Z`);
    if (Number.isNaN(settlementDate.getTime()) || settlementDate.toISOString().slice(0, 10) !== point.settlementDate) continue;
    records.push({
      settlementDate,
      sharesShort: point.sharesShort,
      shortRatio: point.daysToCover,
      averageDailyVolume: point.averageDailyVolume,
      // FINRA publishes no float, so percent of float stays unknown rather than
      // being invented from a float measured on a different date.
      shortPercentFloat: point.shortPercentFloat ?? null,
    });
  }
  return records;
}

export interface ShortInterestResult {
  records: ShortInterestRecord[];
  /** Full settlement history or the latest reported settlements. */
  source: "finra" | "gloom";
  cloudSessionRequired: boolean;
}

export async function loadShortInterest(
  symbol: string,
  client: Pick<typeof apiClient, "getCloudShortInterest"> = apiClient,
): Promise<ShortInterestResult> {
  const request = () => client.getCloudShortInterest(symbol);
  const response = await (connectionHealth?.hasSource(SHORT_INTEREST_CONNECTION_ID)
    ? connectionHealth.track(SHORT_INTEREST_CONNECTION_ID, "fetch", request) : request());
  if (response.status === "empty") return { records: [], source: "finra", cloudSessionRequired: false };
  if (!response.data) throw new Error(`No short interest data for ${symbol}`);
  return { records: normalizeCloudRecords(response.data), source: response.data.source ?? "finra", cloudSessionRequired: false };
}
