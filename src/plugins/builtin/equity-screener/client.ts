import { apiClient } from "../../../api-client";
import type {
  ScreenDefinition,
  ScreenExportResponse,
  ScreenFieldsResponse,
  ScreenPayload,
  ScreenQuery,
  SavedScreen,
  ScreenCheckPayload,
} from "../../../api-client/equity-screener";
import { screenCheckTicker, validateScreenCheck } from "./screen-check";

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
  fields: (signal?: AbortSignal) => apiClient.equityScreener<ScreenFieldsResponse>("fields?include=social,research,attention,hiring-apps,kpis,volatility,dividends,technical,option-volatility,ownership", { signal }),
  export: (definition: ScreenDefinition, snapshotId: string) =>
    apiClient.equityScreener<ScreenExportResponse>("export", json("POST", { ...definition, snapshotId }, { headers: { Accept: "application/json" } })),
  saved: async (signal?: AbortSignal, client: ScreenerClient = apiClient) =>
    (await client.equityScreener<{ screens: SavedScreen[] }>("saved", { signal })).screens,
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
  /** Rows a page holds, at most the server's 200. */
  limit = 100,
): Promise<ScreenPayload> {
  const payload = validateScreenPayload(
    await screenerApi.query(
      { ...parseScreenDefinition(definition), limit, cursor },
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
    throw new Error("Invalid saved screen.");
  parseScreenDefinition(screen.definition);
  return screen;
}
export async function fetchSavedScreens(signal?: AbortSignal, client: ScreenerClient = apiClient) {
  const rows = await screenerApi.saved(signal, client);
  if (!Array.isArray(rows) || rows.length > 50)
    throw new Error("Invalid saved screen collection.");
  return rows.map(validateSavedScreen);
}

export async function fetchScreenCheck(
  definition: ScreenDefinition,
  tickerText: string,
  snapshotId?: string,
  signal?: AbortSignal,
  client: ScreenerClient = apiClient,
): Promise<ScreenCheckPayload> {
  const ticker = screenCheckTicker(tickerText);
  const parsed = parseScreenDefinition(definition);
  const payload = await client.equityScreener<ScreenCheckPayload>("check", json("POST", {
    ...parsed, ...ticker, ...(snapshotId ? { snapshotId } : {}),
  }, { signal }));
  return validateScreenCheck(payload, parsed, ticker, snapshotId);
}
