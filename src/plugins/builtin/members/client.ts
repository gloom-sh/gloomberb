import { apiClient } from "../../../api-client";
import type { FundMembersPayload, FundChangesPayload, MemberFundsPayload } from "../../../api-client/members";
import { createPluginCache } from "../../../data/plugin-cache";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
const policy = { staleMs: 60_000, expireMs: 2 * 60 * 60_000 };
export const fundListCache = createPluginCache<MemberFundsPayload>({ kind: "member-funds", source: "gloom-cloud", schemaVersion: 1, policy });
export const fundMembersCache = createPluginCache<FundMembersPayload>({ kind: "fund-members", source: "gloom-cloud", schemaVersion: 1, policy });
export const fundChangesCache = createPluginCache<FundChangesPayload>({ kind: "fund-changes", source: "gloom-cloud", schemaVersion: 1, policy });
type Client = Pick<typeof apiClient, "getMemberFunds" | "getFundMembers" | "getFundChanges">;
const number = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
function validateMembers(data: FundMembersPayload) {
  if (!data?.fund?.ticker || !Number.isFinite(Date.parse(data.asOf)) || !Array.isArray(data.members)
    || !data.members.every((row) => typeof row.id === "string" && typeof row.name === "string" && [row.weight, row.price, row.changePercent, row.return1WPercent, row.return1MPercent, row.returnYtdPercent, row.contribution].every(number))
    || !data.aggregate || !number(data.aggregate.sum)) throw new Error("Unreadable fund holdings response");
  return data;
}
function validateChanges(data: FundChangesPayload) {
  if (!data?.fund?.ticker || !Array.isArray(data.changes) || !data.changes.every((row) => typeof row.id === "string" && typeof row.reason === "string" && Array.isArray(row.estimates))) throw new Error("Unreadable fund changes response");
  return data;
}
function validateFunds(data: MemberFundsPayload) {
  if (!data || !Array.isArray(data.funds) || !data.funds.every((fund) => typeof fund.ticker === "string" && typeof fund.name === "string")) throw new Error("Unreadable covered funds response");
  return data;
}
async function fetchPayload<T>(fetcher: () => Promise<T>, validate: (data: T) => T) {
  try { return validate(await fetcher()); } catch (error) { throw unavailableOnServer(error, "Fund members are not available on this server yet."); }
}
export const fetchFunds = (client: Client = apiClient) => fetchPayload(() => client.getMemberFunds(), validateFunds);
export const fetchMembers = (fund: string, client: Client = apiClient) => fetchPayload(() => client.getFundMembers(fund), validateMembers);
export const fetchChanges = (fund: string, client: Client = apiClient) => fetchPayload(() => client.getFundChanges(fund), validateChanges);
export const cachedFunds = () => cachedCloudResource(fundListCache, "list", validateFunds);
export const loadFunds = (force = false) => loadCloudResource(fundListCache, "list", () => fetchFunds(), { force, validate: validateFunds });
export const cachedMembers = (fund: string) => cachedCloudResource(fundMembersCache, fund, validateMembers);
export const loadMembers = (fund: string, force = false) => loadCloudResource(fundMembersCache, fund, () => fetchMembers(fund), { force, validate: validateMembers });
export const cachedChanges = (fund: string) => cachedCloudResource(fundChangesCache, fund, validateChanges);
export const loadChanges = (fund: string, force = false) => loadCloudResource(fundChangesCache, fund, () => fetchChanges(fund), { force, validate: validateChanges });
