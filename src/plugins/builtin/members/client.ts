import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { FundMembersPayload, FundChangesPayload, MemberFundsPayload, FundBreadthPayload } from "../../../api-client/members";
import { createPluginCache } from "../../../data/plugin-cache";
import { companyNameCase } from "../../../tickers/company-name";
import { cachedCloudResource, loadCloudResource, unavailableOnServer } from "../shared/cloud-resource";
import { coveredFund, notCoveredMessage } from "./model";
const policy = { staleMs: 60_000, expireMs: 2 * 60 * 60_000 };
export const fundListCache = createPluginCache<MemberFundsPayload>({ kind: "member-funds", source: "gloom-cloud", schemaVersion: 1, policy });
export const fundMembersCache = createPluginCache<FundMembersPayload>({ kind: "fund-members", source: "gloom-cloud", schemaVersion: 1, policy });
export const fundChangesCache = createPluginCache<FundChangesPayload>({ kind: "fund-changes", source: "gloom-cloud", schemaVersion: 1, policy });
export const fundBreadthCache = createPluginCache<FundBreadthPayload>({ kind: "fund-breadth", source: "gloom-cloud", schemaVersion: 1, policy });
type Client = Pick<typeof apiClient, "getMemberFunds" | "getFundMembers" | "getFundChanges">;
const number = (value: unknown) => value === null || typeof value === "number" && Number.isFinite(value);
function validateMembers(data: FundMembersPayload) {
  if (!data?.fund?.ticker || !Number.isFinite(Date.parse(data.asOf)) || !Array.isArray(data.members)
    || !data.members.every((row) => typeof row.id === "string" && typeof row.name === "string" && [row.weight, row.price, row.changePercent, row.return1WPercent, row.return1MPercent, row.returnYtdPercent, row.contribution].every(number))
    || !data.aggregate || !number(data.aggregate.sum)) throw new Error("Unreadable fund holdings response");
  // A holdings file writes every name in capitals; the pane, the report and a watchlist made from it read them as other panes do.
  return { ...data, members: data.members.map((row) => ({ ...row, name: companyNameCase(row.name) })) };
}
function validateChanges(data: FundChangesPayload) {
  if (!data?.fund?.ticker || !Array.isArray(data.changes) || !data.changes.every((row) => typeof row.id === "string" && typeof row.reason === "string" && Array.isArray(row.estimates))) throw new Error("Unreadable fund changes response");
  return data;
}
function validateFunds(data: MemberFundsPayload) {
  if (!data || !Array.isArray(data.funds) || !data.funds.every((fund) => typeof fund.ticker === "string" && typeof fund.name === "string")) throw new Error("Unreadable covered funds response");
  return data;
}
const UNAVAILABLE = "Fund members are not available on this server yet.";
async function fetchPayload<T>(fetcher: () => Promise<T>, validate: (data: T) => T) {
  try { return validate(await fetcher()); } catch (error) { throw unavailableOnServer(error, UNAVAILABLE); }
}
/**
 * A 404 for one fund means either an uncovered fund or a server without the route, and the two read the
 * same. The covered list tells them apart: a fund missing from a readable list is not covered; a list
 * that cannot be read, or that holds the fund, leaves the server-side message.
 */
async function fetchFundPayload<T>(fund: string, fetcher: () => Promise<T>, validate: (data: T) => T, client: Client, unavailable = UNAVAILABLE) {
  try { return validate(await fetcher()); } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      const funds = await fetchFunds(client).then((payload) => payload.funds, () => []);
      if (funds.length && !coveredFund(funds, fund)) throw new Error(notCoveredMessage(fund, funds));
    }
    throw unavailableOnServer(error, unavailable);
  }
}
export const fetchFunds = (client: Client = apiClient) => fetchPayload(() => client.getMemberFunds(), validateFunds);
export const fetchMembers = (fund: string, client: Client = apiClient) => fetchFundPayload(fund, () => client.getFundMembers(fund), validateMembers, client);
export const fetchChanges = (fund: string, client: Client = apiClient) => fetchFundPayload(fund, () => client.getFundChanges(fund), validateChanges, client);
export const cachedFunds = () => cachedCloudResource(fundListCache, "list", validateFunds);
export const loadFunds = (force = false) => loadCloudResource(fundListCache, "list", () => fetchFunds(), { force, validate: validateFunds });
export const cachedMembers = (fund: string) => cachedCloudResource(fundMembersCache, fund, validateMembers);
export const loadMembers = (fund: string, force = false) => loadCloudResource(fundMembersCache, fund, () => fetchMembers(fund), { force, validate: validateMembers });
export const cachedChanges = (fund: string) => cachedCloudResource(fundChangesCache, fund, validateChanges);
export const loadChanges = (fund: string, force = false) => loadCloudResource(fundChangesCache, fund, () => fetchChanges(fund), { force, validate: validateChanges });

function validateBreadth(data: FundBreadthPayload) {
  const row = (value: FundBreadthPayload["history"][number]) => value && /^\d{4}-\d{2}-\d{2}$/.test(value.date)
    && [value.memberCount, value.observed, value.advances, value.declines, value.unchanged, value.advanceDeclineEligible, value.newHighs, value.newLows, value.highLowEligible].every(n => Number.isInteger(n) && n >= 0)
    && [value.ma20, value.ma50, value.ma200].every(m => m && Number.isInteger(m.eligible) && m.eligible >= 0 && Number.isInteger(m.above) && m.above >= 0 && m.above <= m.eligible && number(m.percent))
    && number(value.adLine);
  if (!data?.fund?.ticker || !Array.isArray(data.history) || !data.history.every(row) || (data.latest !== null && !row(data.latest))) throw new Error("Unreadable fund breadth response");
  return data;
}
export const fetchBreadth = (fund: string, client: Client & Pick<typeof apiClient, "getFundBreadth"> = apiClient) => fetchFundPayload(fund, () => client.getFundBreadth(fund), validateBreadth, client, "Fund breadth is not available on this server yet.");
export const cachedBreadth = (fund: string) => cachedCloudResource(fundBreadthCache, fund, validateBreadth);
export const loadBreadth = (fund: string, force = false) => loadCloudResource(fundBreadthCache, fund, () => fetchBreadth(fund), { force, validate: validateBreadth });
