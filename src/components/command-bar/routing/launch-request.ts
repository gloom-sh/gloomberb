import { useEffect, useRef } from "react";
import type { AppState } from "../../../state/app/context";

interface UseCommandBarLaunchRequestOptions {
  commandBarLaunchRequest: AppState["commandBarLaunchRequest"];
  commandBarOpen: boolean;
  openModeRoute: (
    screen: "ticker-search" | "layout",
    initialQuery?: string,
    payload?: Record<string, unknown>,
  ) => void;
}

export function useCommandBarLaunchRequest({
  commandBarLaunchRequest,
  commandBarOpen,
  openModeRoute,
}: UseCommandBarLaunchRequestOptions) {
  const processedLaunchSequenceRef = useRef<number | null>(null);

  useEffect(() => {
    const launch = commandBarLaunchRequest;
    if (!launch) {
      processedLaunchSequenceRef.current = null;
      return;
    }
    if (!commandBarOpen) return;
    if (processedLaunchSequenceRef.current === launch.sequence) return;
    processedLaunchSequenceRef.current = launch.sequence;

    if (launch.kind === "ticker-search") {
      openModeRoute("ticker-search", launch.query ?? "");
    }
    // Submitting text needs the selection runtime, which the surface wires up
    // after this hook; it watches for run-query itself.
  }, [
    commandBarLaunchRequest,
    commandBarOpen,
    openModeRoute,
  ]);
}
