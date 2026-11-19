import { apiClient } from "../../../api-client";
import type { CloudCongressHousePayload } from "../../../api-client";
import { normalizeIssuerResearchTicker, type CloudCongressHouseParams } from "../../../api-client/paths";
import type { HeadlessPaneApiClient } from "../../../types/plugin";

/** Reads the feed named by `params.chamber`, House when omitted. */
export function loadCongressHouse(
  params: CloudCongressHouseParams = {},
  client: Pick<HeadlessPaneApiClient, "getCloudCongressHouse"> = apiClient,
  signal?: AbortSignal,
): Promise<CloudCongressHousePayload> {
  const ticker = params.ticker ? normalizeIssuerResearchTicker(params.ticker) : undefined;
  return client.getCloudCongressHouse(ticker ? { ...params, ticker } : params, { signal });
}
