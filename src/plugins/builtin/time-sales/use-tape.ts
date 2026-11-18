import { createContext, useContext, useEffect, useRef, useState } from "react";
import { apiClient } from "../../../api-client";
import { isTransientFailure } from "../../../api-client/errors";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import type { TapeSnapshot } from "../../../api-client/tape";
import { useSavedCopyFooter } from "../../../components/layout/pane/footer/registration";
import { deleteSavedCopy, readSavedCopy, writeSavedCopy } from "../../../data/pane-saved-copies";
import { fetchTape, validateTape } from "./client";
import { useAppVisible } from "../../../state/app/activity";

export type TapeClient = Pick<typeof apiClient, "subscribeTape" | "getCloudTape"> & { snapshotOnly?: boolean };
export const TapeClientContext = createContext<TapeClient | null>(null);

interface TapeState {
  data: TapeSnapshot | null;
  loading: boolean;
  error: string | null;
  transport: string | null;
  epoch: number;
  savedAt: number | null;
  owner: object;
}

export function useTape(symbol: string, exchange: string, sessionKey: unknown, refresh: number, suppliedClient?: TapeClient) {
  const contextualClient = useContext(TapeClientContext);
  const client = suppliedClient ?? contextualClient ?? apiClient;
  const scope = useCloudDisplayScope();
  const key = scope && client === apiClient ? { key: ["time-sales", scope, symbol, exchange] } : null;
  const epoch = useRef(0);
  const identity = useRef({ symbol, exchange, sessionKey, client, scope });
  if (identity.current.symbol !== symbol || identity.current.exchange !== exchange || !Object.is(identity.current.sessionKey, sessionKey)
    || identity.current.scope !== scope || identity.current.client !== client) {
    identity.current = { symbol, exchange, sessionKey, client, scope };
  }
  const owner = identity.current;
  const open = (nextEpoch: number): TapeState => {
    const saved = key ? readSavedCopy<TapeSnapshot>(key) : null;
    return { data: saved?.value ?? null, savedAt: saved?.fetchedAt ?? null, loading: true, error: null, transport: null, epoch: nextEpoch, owner };
  };
  const [state, setState] = useState(() => open(0));
  const view = state.owner === owner ? state : open(++epoch.current);
  if (view !== state) setState(view);
  const latest = useRef(view);
  latest.current = view;
  useSavedCopyFooter(view.savedAt, view.loading);
  // A hidden app drops the tape subscription like every other stream. The
  // prints on screen stay, and coming back resyncs through the snapshot.
  const appVisible = useAppVisible();
  useEffect(() => {
    if (!appVisible) return;
    let active = true;
    let abort = new AbortController();
    const requestEpoch = ++epoch.current;
    let accepted = latest.current.savedAt === null ? latest.current.data : null;
    setState((current) => ({ ...current, loading: true, error: null, epoch: requestEpoch }));
    const accept = (data: TapeSnapshot) => {
      if (!active) return;
      if (accepted && Date.parse(data.generatedAt) < Date.parse(accepted.generatedAt)) return;
      accepted = data;
      if (key && (data.trades.length || data.quotes.length)) writeSavedCopy(key, data, Date.now(), 30_000);
      setState({ data, savedAt: null, loading: false, error: null, transport: null, epoch: epoch.current, owner });
    };
    const bootstrap = (bootstrapEpoch: number) => {
      const controller = abort;
      void fetchTape(symbol, exchange, controller.signal, client).then((data) => {
        if (bootstrapEpoch === epoch.current && !controller.signal.aborted) accept(data);
      }, (error) => {
        if (!active || controller.signal.aborted || bootstrapEpoch !== epoch.current) return;
        const discard = !isTransientFailure(error);
        if (key && discard) deleteSavedCopy(key);
        setState((current) => ({ ...current,
          ...(discard && current.savedAt !== null ? { data: null, savedAt: null } : {}),
          loading: false, error: error instanceof Error ? error.message : "Tape unavailable" }));
      });
    };
    const unsubscribe = client.subscribeTape(symbol, exchange, (event) => {
      if (!active) return;
      if (event.type === "data") {
        try { accept(validateTape(event.payload, symbol, exchange)); }
        catch (error) { setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Tape snapshot unavailable" })); }
      } else if (event.type === "reset") {
        // Invalidate both the bootstrap and any frozen copy before the new session arrives.
        abort.abort();
        abort = new AbortController();
        const nextEpoch = ++epoch.current;
        accepted = null;
        if (key) deleteSavedCopy(key);
        setState({ data: null, savedAt: null, loading: true, error: null, transport: event.reason, epoch: nextEpoch, owner });
        bootstrap(nextEpoch);
      } else setState((current) => ({ ...current, loading: false, transport: event.reason }));
    });
    if (requestEpoch === epoch.current) bootstrap(requestEpoch);
    return () => { active = false; abort.abort(); unsubscribe(); };
  }, [owner, refresh, appVisible]);
  return { ...view, loading: view.loading && view.savedAt === null, snapshotOnly: "snapshotOnly" in client && client.snapshotOnly === true };
}
