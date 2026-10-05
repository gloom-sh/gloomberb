import { apiClient } from "../../../api-client";
import { THEME_PERIODS, type ThemeAggregate, type ThemeMembersPayload, type ThemeSummary, type ThemesPayload } from "../../../api-client/themes";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";

const policy = { staleMs: 60_000, expireMs: 2 * 60 * 60_000 };
export const themesCache = createPluginCache<ThemesPayload>({ kind: "themes", source: "gloom-cloud", schemaVersion: 1, policy });
export const membersCache = createPluginCache<ThemeMembersPayload>({ kind: "theme-members", source: "gloom-cloud", schemaVersion: 1, policy });
type Client = Pick<typeof apiClient, "getCloudThemes" | "getCloudThemeMembers">;
const numberOrNull = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
const aggregate = (value: ThemeAggregate) => value && numberOrNull(value.value) && Number.isInteger(value.covered)
  && Number.isInteger(value.total) && value.covered >= 0 && value.covered <= value.total;
const summary = (row: ThemeSummary) => row && typeof row.id === "string" && typeof row.name === "string"
  && typeof row.description === "string" && Array.isArray(row.keywords) && row.keywords.every((word) => typeof word === "string")
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
    || !payload.members.every((row) => row && typeof row.symbol === "string" && (row.name === null || typeof row.name === "string")
      && ["price", ...THEME_PERIODS].every((field) => numberOrNull(row[field as "price"])))) throw new Error("The server returned unreadable theme members");
  return payload;
}
async function fetchPayload<T>(request: () => Promise<T>, validate: (value: T) => T): Promise<T> {
  try { return validate(await request()); } catch (error) {
    throw unavailableOnServer(error, "Thematic baskets are not available on this server yet.");
  }
}
export const fetchThemes = (client: Client = apiClient) => fetchPayload(() => client.getCloudThemes(), validateThemes);
export const fetchThemeMembers = (id: string, client: Client = apiClient) => fetchPayload(() => client.getCloudThemeMembers(id), validateMembers);
export const cachedThemes = () => cachedCloudResource(themesCache, "list", validateThemes);
export const loadThemes = (force = false) => loadCloudResource(themesCache, "list", () => fetchThemes(), { force, validate: validateThemes });
export const cachedMembers = (id: string) => cachedCloudResource(membersCache, id, validateMembers);
export const loadMembers = (id: string, force = false) => loadCloudResource(membersCache, id, () => fetchThemeMembers(id), { force, validate: validateMembers });
