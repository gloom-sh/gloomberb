import { useEffect, useRef, useState } from "react";
import { apiClient } from "../../../api-client";
import type { TapeSnapshot } from "../../../api-client/tape";
import { fetchTape, validateTape } from "./client";

type TapeClient = Pick<typeof apiClient, "subscribeTape" | "getCloudTape">;
export function useTape(symbol: string, exchange: string, sessionKey: unknown, refresh: number, client: TapeClient = apiClient) {
  const epoch = useRef(0);
  const identity = useRef<{ symbol: string; exchange: string; sessionKey: unknown } | null>(null);
  const [state, setState] = useState<{ data: TapeSnapshot | null; loading: boolean; error: string | null; transport: string | null; epoch: number }>({ data: null, loading: true, error: null, transport: null, epoch: 0 });
  useEffect(() => {
    let active = true;
    let abort = new AbortController();
    const requestEpoch = ++epoch.current;
    const sameSession = identity.current?.symbol === symbol && identity.current.exchange === exchange && Object.is(identity.current.sessionKey, sessionKey);
    identity.current = { symbol, exchange, sessionKey };
    setState((current) => ({ data: sameSession ? current.data : null, loading: true, error: null, transport: sameSession ? current.transport : null, epoch: requestEpoch }));
    const accept = (data: TapeSnapshot) => {
      if (!active) return;
      setState((current) => current.data && Date.parse(data.generatedAt) < Date.parse(current.data.generatedAt) ? current
        : { data, loading: false, error: null, transport: null, epoch: epoch.current });
    };
    const bootstrap = (bootstrapEpoch: number) => {
      const controller = abort;
      void fetchTape(symbol, exchange, controller.signal, client).then((data) => {
        if (bootstrapEpoch === epoch.current && !controller.signal.aborted) accept(data);
      }, (error) => {
        if (!active || controller.signal.aborted || bootstrapEpoch !== epoch.current) return;
        setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Tape unavailable" }));
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
        setState({ data: null, loading: true, error: null, transport: event.reason, epoch: nextEpoch });
        bootstrap(nextEpoch);
      } else setState((current) => ({ ...current, loading: false, transport: event.reason }));
    });
    if (requestEpoch === epoch.current) bootstrap(requestEpoch);
    return () => { active = false; abort.abort(); unsubscribe(); };
  }, [symbol, exchange, sessionKey, refresh, client]);
  return state;
}
