import { useEffect, useMemo, useState } from "react";
import type { AppState } from "../../../../state/app/context";
import type { BrokerAdapter, BrokerConnectionStatus } from "../../../../types/broker";
import type { BrokerInstanceConfig } from "../../../../types/config";
import type { Portfolio } from "../../../../types/ticker";
import type { BrokerAccount } from "../../../../types/trading";
import { getBrokerInstance } from "../../../../utils/broker-instances";
import { usePluginBrokerActions } from "../../../runtime";
import type { OfflineBroker } from "../../shared/broker-reconnect";
import { tf } from "../../../../i18n";
import { isSignedInBrokerProfile, signedInBrokerId } from "../../../../brokers/signed-in/profile";
import { accountsShownFor } from "../../../../brokers/broker-portfolio-sync";
import { resolvePortfolioAccountState, type ResolvedPortfolioAccountState } from "./index";

const EMPTY_ACCOUNTS = { instanceId: null, accounts: [] as BrokerAccount[], error: null };

export interface LiveBrokerAccounts {
  status: BrokerConnectionStatus | null;
  accounts: BrokerAccount[];
  /** Set when the broker refused to list accounts. */
  error: string | null;
}

/** Brokers rewrite the status timestamp on every warning; only these fields change what a pane shows. */
function isSameBrokerStatus(left: BrokerConnectionStatus | null, right: BrokerConnectionStatus | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.state === right.state
    && left.message === right.message
    && left.mode === right.mode
    && left.quoteData === right.quoteData;
}

/**
 * Connection status and live accounts of one broker profile. Accounts load
 * when the profile becomes connected and again whenever `refreshKey` changes
 * (pass the stored accounts, which an explicit sync or connect replaces). A
 * status rewrite alone never reloads them: IBKR reports every per-request
 * error through its status and Robinhood rewrites it on each load, which
 * would otherwise reload the account in a loop.
 */
export function useLiveBrokerAccounts(
  broker: BrokerAdapter | null | undefined,
  brokerInstance: BrokerInstanceConfig | null | undefined,
  refreshKey?: unknown,
): LiveBrokerAccounts {
  const [status, setStatus] = useState<BrokerConnectionStatus | null>(null);
  useEffect(() => {
    const readStatus = () => brokerInstance && broker?.getStatus ? broker.getStatus(brokerInstance) : null;
    const update = () => {
      const next = readStatus();
      setStatus((current) => isSameBrokerStatus(current, next) ? current : next);
    };
    update();
    if (!brokerInstance || !broker?.subscribeStatus) return;
    return broker.subscribeStatus(brokerInstance, update);
  }, [broker, brokerInstance]);

  const connected = status?.state === "connected";
  const instanceId = brokerInstance?.id ?? null;
  // Keyed by profile so a reload keeps showing the previous accounts instead
  // of flashing the cached ones, while another profile's accounts never leak.
  const [loaded, setLoaded] = useState<{ instanceId: string | null; accounts: BrokerAccount[]; error: string | null }>(EMPTY_ACCOUNTS);
  useEffect(() => {
    if (!brokerInstance || !broker?.listAccounts || !connected) {
      setLoaded(EMPTY_ACCOUNTS);
      return;
    }
    let cancelled = false;
    broker.listAccounts(brokerInstance)
      .then((accounts) => {
        if (!cancelled) setLoaded({ instanceId: brokerInstance.id, accounts, error: null });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLoaded({ instanceId: brokerInstance.id, accounts: [], error: reason instanceof Error ? reason.message : String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [broker, brokerInstance, connected, refreshKey]);

  const current = connected && loaded.instanceId === instanceId ? loaded : EMPTY_ACCOUNTS;
  return { status, accounts: current.accounts, error: current.error };
}

export interface PortfolioAccountStateResult {
  accountState: ResolvedPortfolioAccountState | null;
  /** Set when the broker refused to list accounts, so "no cash" is not mistaken for a clean empty. */
  accountsError: string | null;
  /**
   * The portfolio's broker while it cannot be reached, such as after its
   * sign-in lapsed: the positions on screen are its last sync. Accounts are
   * listed only while it is connected, so this is the only word of why the
   * account is missing or stale.
   */
  offline: OfflineBroker | null;
}

/**
 * The broker behind a portfolio while Gloom cannot reach it: disconnected,
 * failing, without the plugin that connects it, or turned off (`disabled`),
 * which nothing syncs until it is enabled. Null while it is connected or
 * connecting, before it reports a status, and for one that only syncs on
 * demand (IBKR Flex), which is never connected.
 */
export function resolveOfflineBroker(
  portfolio: Portfolio | null,
  brokerInstance: BrokerInstanceConfig | null | undefined,
  broker: BrokerAdapter | null | undefined,
  status: BrokerConnectionStatus | null,
): OfflineBroker | null {
  if (!portfolio || !brokerInstance) return null;
  const syncedAt = portfolio.lastSyncedAt ?? brokerInstance.lastSyncedAt ?? null;
  // A profile signed in through Gloom names its broker, not the adapter it needs.
  const brokerName = broker
    ? broker.describeInstance?.(brokerInstance).brokerName ?? broker.name
    : (isSignedInBrokerProfile(brokerInstance) ? signedInBrokerId(brokerInstance) : brokerInstance.brokerType).toUpperCase();
  if (brokerInstance.enabled === false) {
    return { instance: brokerInstance, brokerName, syncedAt, reason: tf("{broker} disabled", { broker: brokerName }), reconnectable: !!broker, disabled: true };
  }
  if (!broker) {
    return { instance: brokerInstance, brokerName, syncedAt, reason: tf("{broker} unavailable", { broker: brokerName }), reconnectable: false };
  }
  if (!status || status.state === "connected" || status.state === "connecting") return null;
  if (status.mode?.toLowerCase() === "flex") return null;
  const reason = status.state === "error"
    ? status.message?.trim() || tf("{broker} unavailable", { broker: brokerName })
    : tf("{broker} disconnected", { broker: brokerName });
  return { instance: brokerInstance, brokerName, syncedAt, reason, reconnectable: true };
}

/**
 * The broker account behind a portfolio: live while its broker is connected,
 * the last synced one otherwise. Live accounts reload on connect and when a
 * sync or connect replaces the stored accounts, never on a status rewrite.
 */
export function usePortfolioAccountState(
  portfolio: Portfolio | null,
  state: Pick<AppState, "config" | "brokerAccounts">,
): PortfolioAccountStateResult {
  const instanceId = portfolio?.brokerInstanceId;
  const brokerInstance = useMemo(
    () => instanceId ? getBrokerInstance(state.config.brokerInstances, instanceId) : null,
    [instanceId, state.config.brokerInstances],
  );
  const { getBrokerAdapter } = usePluginBrokerActions();
  const broker = brokerInstance ? getBrokerAdapter(brokerInstance.brokerType) : null;
  const live = useLiveBrokerAccounts(broker, brokerInstance, instanceId ? state.brokerAccounts[instanceId] : undefined);
  // An account another profile holds under its own number is that profile's, here as in sync.
  const snapshot = useMemo(
    () => ({ status: live.status, accounts: brokerInstance ? accountsShownFor(state.config, brokerInstance, live.accounts) : live.accounts }),
    [brokerInstance, live.accounts, live.status, state.config],
  );
  const accountState = useMemo(
    () => resolvePortfolioAccountState(portfolio, state, snapshot),
    [portfolio, snapshot, state.brokerAccounts, state.config],
  );
  const offline = useMemo(
    () => resolveOfflineBroker(portfolio, brokerInstance, broker, live.status),
    [broker, brokerInstance, live.status, portfolio],
  );
  return useMemo(
    () => ({ accountState, accountsError: live.error, offline }),
    [accountState, live.error, offline],
  );
}
