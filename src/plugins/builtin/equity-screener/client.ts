import { apiClient } from "../../../api-client";
import type {
  ScreenDefinition,
  ScreenFieldsResponse,
  ScreenPayload,
  SavedScreen,
} from "../../../api-client/equity-screener";
import { parseScreenDefinition, screenDefinitionKey, validateScreenPayload } from "./model";

export async function fetchScreen(
  definition: ScreenDefinition,
  cursor: string | null = null,
  signal?: AbortSignal,
  client: Pick<typeof apiClient, "queryCloudEquityScreen"> = apiClient,
): Promise<ScreenPayload> {
  const payload = validateScreenPayload(
    await client.queryCloudEquityScreen(
      { ...parseScreenDefinition(definition), limit: 100, cursor },
      { signal },
    ),
  );
  if (screenDefinitionKey(payload.definition) !== screenDefinitionKey(definition))
    throw new Error("Screen response did not match the requested criteria.");
  return payload;
}
export async function fetchScreenFields(
  signal?: AbortSignal,
): Promise<ScreenFieldsResponse> {
  const data = await apiClient.getCloudEquityScreenFields({ signal });
  if (
    data.version !== 1 ||
    !Array.isArray(data.fields) ||
    !data.fields.length ||
    !data.limits ||
    data.limits.criteria < 1
  )
    throw new Error("Screen field metadata is unavailable.");
  return data;
}
export function validateSavedScreen(screen: SavedScreen): SavedScreen {
  if (
    !screen ||
    typeof screen.id !== "string" ||
    typeof screen.name !== "string" ||
    !Number.isInteger(screen.revision) ||
    screen.revision < 1
  )
    throw new Error("Invalid saved screen from Gloom Cloud.");
  parseScreenDefinition(screen.definition);
  return screen;
}
export async function fetchSavedScreens() {
  const rows = await apiClient.getCloudSavedEquityScreens();
  if (!Array.isArray(rows) || rows.length > 50)
    throw new Error("Invalid saved screen collection.");
  return rows.map(validateSavedScreen);
}
