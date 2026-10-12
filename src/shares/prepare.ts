import { useEffect, useRef } from "react";

const preparations = new Map<string, () => void | Promise<void>>();

/** Flush a pane's pending interaction into portable state before taking its picture and link. */
export function usePaneSharePreparation(paneId: string, prepare: () => void | Promise<void>): void {
  const latest = useRef(prepare);
  latest.current = prepare;
  useEffect(() => {
    const run = () => latest.current();
    preparations.set(paneId, run);
    return () => {
      if (preparations.get(paneId) === run) preparations.delete(paneId);
    };
  }, [paneId]);
}

export async function preparePaneShare(paneId: string): Promise<void> {
  await preparations.get(paneId)?.();
}
