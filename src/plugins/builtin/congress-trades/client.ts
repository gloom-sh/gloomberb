import { apiClient } from "../../../api-client";
import type { CloudCongressHousePayload } from "../../../api-client";
import type { CloudCongressHouseParams } from "../../../api-client/paths";
import type { HeadlessPaneApiClient } from "../../../types/plugin";

export function loadCongressHouse(
  params: CloudCongressHouseParams = {},
  client: Pick<HeadlessPaneApiClient, "getCloudCongressHouse"> = apiClient,
): Promise<CloudCongressHousePayload> {
  return client.getCloudCongressHouse(params);
}
