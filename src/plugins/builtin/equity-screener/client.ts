import { apiClient } from "../../../api-client";
import type {
  ScreenDefinition,
  ScreenExportResponse,
  ScreenFieldsResponse,
  ScreenPayload,
  ScreenQuery,
  SavedScreen,
} from "../../../api-client/equity-screener";

type ScreenerClient = Pick<typeof apiClient, "equityScreener">;
const json = (method: string, body: unknown, init: RequestInit = {}): RequestInit => ({
  ...init,
  method,
  body: JSON.stringify(body),
});
const savedPath = (id: string) => `saved/${encodeURIComponent(id)}`;

export const screenerApi = {
  query: (query: ScreenQuery, signal?: AbortSignal, client: ScreenerClient = apiClient) =>
    client.equityScreener<ScreenPayload>("query", json("POST", query, { signal })),
  fields: (signal?: AbortSignal) => apiClient.equityScreener<ScreenFieldsResponse>("fields", { signal }),
  export: (definition: ScreenDefinition, snapshotId: string) =>
    apiClient.equityScreener<ScreenExportResponse>("export", json("POST", { ...definition, snapshotId }, { headers: { Accept: "application/json" } })),
  saved: async () => (await apiClient.equityScreener<{ screens: SavedScreen[] }>("saved")).screens,
  create: async (name: string, definition: ScreenDefinition) =>
    (await apiClient.equityScreener<{ screen: SavedScreen }>("saved", json("POST", { name, definition }))).screen,
  update: async (id: string, revision: number, name: string, definition: ScreenDefinition) =>
    (await apiClient.equityScreener<{ screen: SavedScreen }>(savedPath(id), json("PATCH", { revision, name, definition }))).screen,
  remove: (id: string, revision: number) =>
    apiClient.equityScreener<{ deleted: true }>(savedPath(id), json("DELETE", { revision })),
};
import { parseScreenDefinition, screenDefinitionKey, validateScreenPayload } from "./model";

export async function fetchScreen(
  definition: ScreenDefinition,
  cursor: string | null = null,
  signal?: AbortSignal,
  client: ScreenerClient = apiClient,
): Promise<ScreenPayload> {
  const payload = validateScreenPayload(
    await screenerApi.query(
      { ...parseScreenDefinition(definition), limit: 100, cursor },
      signal,
      client,
    ),
  );
  if (screenDefinitionKey(payload.definition) !== screenDefinitionKey(definition))
    throw new Error("Screen response did not match the requested criteria.");
  return payload;
}
export async function fetchScreenFields(
  signal?: AbortSignal,
): Promise<ScreenFieldsResponse> {
  const data = await screenerApi.fields(signal);
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
  const rows = await screenerApi.saved();
  if (!Array.isArray(rows) || rows.length > 50)
    throw new Error("Invalid saved screen collection.");
  return rows.map(validateSavedScreen);
}
