import { apiClient, type CloudCdsResponse } from "../../../api-client";
import { normalizeCdsTrades, type CdsTrade } from "./model";

/** One trading week of public dissemination is what "recent activity" means here. */
const CDS_HISTORY_DAYS = 5;
const CDS_TRADE_LIMIT = 500;

export interface CdsActivity {
  source: string;
  asOf: string | null;
  trades: CdsTrade[];
}

export type CdsActivityLoader = (issuer: string | null) => Promise<CdsActivity>;

export async function loadCdsActivity(
  issuer: string | null,
  fetchCds: (params: { issuer?: string; days?: number; limit?: number }) => Promise<CloudCdsResponse>
    = (params) => apiClient.getCloudCds(params),
): Promise<CdsActivity> {
  const response = await fetchCds({
    ...(issuer ? { issuer } : {}),
    days: CDS_HISTORY_DAYS,
    limit: CDS_TRADE_LIMIT,
  });
  return {
    source: response.source,
    asOf: response.asOf,
    trades: normalizeCdsTrades(response.trades ?? []),
  };
}
