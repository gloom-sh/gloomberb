/**
 * Which of a profile's accounts Gloom shows (`BrokerInstanceConfig.excludedAccounts`). Every
 * account is in until the user leaves it out in Brokers; one left out has no portfolio, is offered
 * nowhere an order is placed, and is not synced.
 */
import type { BrokerExcludedAccount, BrokerInstanceConfig } from "../types/config";
import { isRecord } from "../utils/guards";

type AccountChoiceSource = Pick<BrokerInstanceConfig, "excludedAccounts">;

/** The ids of the accounts the user left out of a profile. */
export function excludedAccountIds(instance: AccountChoiceSource): ReadonlySet<string> {
  return new Set((instance.excludedAccounts ?? []).map((entry) => entry.accountId));
}

export function isExcludedAccount(instance: AccountChoiceSource, accountId: string | undefined): boolean {
  return !!accountId && !!instance.excludedAccounts?.some((entry) => entry.accountId === accountId);
}

/** `accounts` without those the user left out of the profile: the same array when none is. */
export function includedBrokerAccounts<T extends { accountId: string }>(instance: AccountChoiceSource, accounts: T[]): T[] {
  if (!instance.excludedAccounts?.length) return accounts;
  const excluded = excludedAccountIds(instance);
  const included = accounts.filter((account) => !excluded.has(account.accountId));
  return included.length === accounts.length ? accounts : included;
}

/** One of a profile's accounts as Brokers offers it to keep or leave out. */
export interface ProfileAccountChoice {
  accountId: string;
  name: string;
  included: boolean;
}

/**
 * Every account of a profile to choose from: the ones it reports, then the ones the user left out,
 * which it no longer reads. None for a profile with a single account it shows, which has nothing to
 * choose; one left out is always offered back.
 */
export function profileAccountChoices(
  instance: AccountChoiceSource,
  reported: ReadonlyArray<{ accountId: string; name?: string }>,
): ProfileAccountChoice[] {
  const excluded = excludedAccountIds(instance);
  const choices: ProfileAccountChoice[] = reported
    .filter((account) => !excluded.has(account.accountId))
    .map((account) => ({ accountId: account.accountId, name: account.name?.trim() || account.accountId, included: true }));
  const listed = new Set(choices.map((choice) => choice.accountId));
  for (const entry of instance.excludedAccounts ?? []) {
    if (listed.has(entry.accountId)) continue;
    listed.add(entry.accountId);
    choices.push({ accountId: entry.accountId, name: entry.name || entry.accountId, included: false });
  }
  return choices.length > 1 || choices.some((choice) => !choice.included) ? choices : [];
}

/** The accounts left out once `excludedIds` are the ones unticked among `choices`, by the names they show. */
export function excludedAccountsFrom(
  choices: readonly ProfileAccountChoice[],
  excludedIds: ReadonlySet<string>,
): BrokerExcludedAccount[] {
  return choices.flatMap((choice) => excludedIds.has(choice.accountId) ? [{ accountId: choice.accountId, name: choice.name }] : []);
}

/** Whether two lists leave out the same accounts, whatever their order or names. */
export function sameExcludedAccounts(
  left: readonly BrokerExcludedAccount[] | undefined,
  right: readonly BrokerExcludedAccount[] | undefined,
): boolean {
  const ids = (list: readonly BrokerExcludedAccount[] | undefined) => [...new Set((list ?? []).map((entry) => entry.accountId))].sort();
  return ids(left).join("\0") === ids(right).join("\0");
}

/**
 * A stored or pulled list of left-out accounts: entries without an account id are dropped, and an
 * id listed twice counts once. Undefined when the value is not a list at all.
 */
export function readExcludedAccounts(value: unknown): BrokerExcludedAccount[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.accountId !== "string") return [];
    const accountId = entry.accountId.trim();
    if (!accountId || seen.has(accountId)) return [];
    seen.add(accountId);
    return [{ accountId, name: typeof entry.name === "string" ? entry.name : "" }];
  });
}
