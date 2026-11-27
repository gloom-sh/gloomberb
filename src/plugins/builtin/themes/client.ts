import { apiClient } from "../../../api-client";
import { THEME_PERIODS, type ThemeAggregate, type ThemeMembersPayload, type ThemeSummary, type ThemesPayload } from "../../../api-client/themes";
import { isNullableFinite, isNullableString, isStringArray } from "../../../utils/guards";
import { createCloudEndpoint } from "../shared/cloud-resource";

const policy = { staleMs: 60_000, expireMs: 2 * 60 * 60_000 };
const unavailableMessage = "Thematic baskets are not available on this server yet.";
type Client = Pick<typeof apiClient, "getCloudThemes" | "getCloudThemeMembers">;
const aggregate = (value: ThemeAggregate) => value && isNullableFinite(value.value) && Number.isInteger(value.covered)
  && Number.isInteger(value.total) && value.covered >= 0 && value.covered <= value.total;
const summary = (row: ThemeSummary) => row && typeof row.id === "string" && typeof row.name === "string"
  && typeof row.description === "string" && isStringArray(row.keywords)
  && Number.isInteger(row.memberCount) && row.memberCount > 0 && aggregate(row.breadth)
  && THEME_PERIODS.every((period) => aggregate(row.returns?.[period]));
const metadata = (payload: ThemesPayload | ThemeMembersPayload) => payload && Number.isFinite(Date.parse(payload.asOf))
  && typeof payload.snapshotId === "string" && typeof payload.stale === "boolean";
function validateThemes(payload: ThemesPayload): ThemesPayload {
  if (!metadata(payload) || !Array.isArray(payload.themes) || !payload.themes.every(summary)) throw new Error("The server returned unreadable thematic baskets");
  return payload;
}
function validateMembers(payload: ThemeMembersPayload): ThemeMembersPayload {
  if (!metadata(payload) || !summary(payload.theme) || !Array.isArray(payload.members)
    || !payload.members.every((row) => row && typeof row.symbol === "string" && isNullableString(row.name)
      && ["price", ...THEME_PERIODS].every((field) => isNullableFinite(row[field as "price"])))) throw new Error("The server returned unreadable theme members");
  return payload;
}
const themesEndpoint = createCloudEndpoint<void, ThemesPayload, Pick<Client, "getCloudThemes">>({
  kind: "themes", schemaVersion: 1, policy, key: "list", defaultClient: apiClient,
  fetch: (_args, client) => client.getCloudThemes(), validate: validateThemes, unavailableMessage,
});
const membersEndpoint = createCloudEndpoint<string, ThemeMembersPayload, Pick<Client, "getCloudThemeMembers">>({
  kind: "theme-members", schemaVersion: 1, policy, key: (id) => id, defaultClient: apiClient,
  fetch: (id, client) => client.getCloudThemeMembers(id), validate: validateMembers, unavailableMessage,
});
export const themesCache = themesEndpoint.cache;
export const membersCache = membersEndpoint.cache;
export const fetchThemes = (client: Client = apiClient) => themesEndpoint.fetch(undefined, { client });
export const fetchThemeMembers = (id: string, client: Client = apiClient) => membersEndpoint.fetch(id, { client });
export const cachedThemes = () => themesEndpoint.cached();
export const loadThemes = (force = false) => themesEndpoint.load(undefined, { force });
export const cachedMembers = (id: string) => membersEndpoint.cached(id);
export const loadMembers = (id: string, force = false) => membersEndpoint.load(id, { force });
