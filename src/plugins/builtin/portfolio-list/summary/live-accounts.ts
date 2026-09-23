import { useEffect, useMemo, useState } from "react";
import type { AppState } from "../../../../state/app/context";
import type { BrokerAdapter, BrokerConnectionStatus } from "../../../../types/broker";
import type { BrokerInstanceConfig } from "../../../../types/config";
import type { Portfolio } from "../../../../types/ticker";
import type { BrokerAccount } from "../../../../types/trading";
import { getBrokerInstance } from "../../../../utils/broker-instances";
import { usePluginBrokerActions } from "../../../runtime";
import { resolvePortfolioAccountState, type ResolvedPortfolioAccountState } from "./index";

const EMPTY_ACCOUNTS = { instanceId: null, accounts: [] as BrokerAccount[], error: null };

export interface LiveBrokerAccounts {
  status: BrokerConnectionStatus | null;
  accounts: BrokerAccount[];
  /** Set when the broker refused to list accounts. */
  error: string | null;
}

/** Brokers rewrite the status timestamp on every warning; only these fields change what a pane shows. */
export function isSameBrokerStatus(left: BrokerConnectionStatus | null, right: BrokerConnectionStatus | null): boolean {
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
  const snapshot = useMemo(
    () => ({ status: live.status, accounts: live.accounts }),
    [live.accounts, live.status],
  );
  const accountState = useMemo(
    () => resolvePortfolioAccountState(portfolio, state, snapshot),
    [portfolio, snapshot, state.brokerAccounts, state.config],
  );
  return useMemo(() => ({ accountState, accountsError: live.error }), [accountState, live.error]);
}
