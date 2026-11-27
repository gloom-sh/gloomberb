import { useCallback, useEffect, useRef } from "react";
import { isTransientFailure } from "../../../api-client/errors";
import { useAsyncResource } from "../../../public/react";
import { fetchTreasuryCash, fetchTreasuryDebt, fetchTreasuryHistory } from "./client";
import { TREASURY_DAILY_PANE_ID } from "./model";

function useStatementSection<T>(section: string, read: (signal: AbortSignal, timeoutMs?: number) => Promise<T>, timeoutMs?: number) {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      return await read(controller.signal, timeoutMs);
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [read, timeoutMs]);
  return useAsyncResource(load, {
    savedCopy: { key: [TREASURY_DAILY_PANE_ID, section] },
    clearOnError: (error) => !isTransientFailure(error),
    showSavedCopyFooter: false,
  });
}

export function useTreasuryDailyResources(timeoutMs?: number) {
  return {
    cash: useStatementSection("cash", fetchTreasuryCash, timeoutMs),
    debt: useStatementSection("debt", fetchTreasuryDebt, timeoutMs),
    history: useStatementSection("history", fetchTreasuryHistory, timeoutMs),
  };
}
