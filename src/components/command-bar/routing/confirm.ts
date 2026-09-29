import {
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CommandBarRoute } from "../workflow/types";

interface CloseCommandBarOptions {
  revertThemePreview?: boolean;
}

interface CommandBarInlineConfirmOptions {
  confirmId: string;
  title: string;
  body: string[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void | Promise<void>;
  successBehavior?: "close" | "back" | "stay";
  /** Runs once the confirmed route has closed or gone back, for work that belongs after it. */
  onSuccess?: () => void;
}

export type OpenInlineConfirm = (options: CommandBarInlineConfirmOptions) => void;

interface UseCommandBarConfirmRouteOptions {
  closeAll: (options?: CloseCommandBarOptions) => void;
  currentRoute: CommandBarRoute | null;
  pushRoute: (route: CommandBarRoute) => void;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
}

export function useCommandBarConfirmRoute({
  closeAll,
  currentRoute,
  pushRoute,
  setRouteStack,
  updateTopRoute,
}: UseCommandBarConfirmRouteOptions): {
  confirmCurrentRoute: () => Promise<void>;
  openInlineConfirm: OpenInlineConfirm;
} {
  const openInlineConfirm = useCallback((options: CommandBarInlineConfirmOptions) => {
    pushRoute({
      kind: "confirm",
      confirmId: options.confirmId,
      title: options.title,
      body: options.body,
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel || "Back",
      tone: options.tone || "danger",
      onConfirm: options.onConfirm,
      ...(options.onSuccess ? { onSuccess: options.onSuccess } : {}),
      pending: false,
      error: null,
      successBehavior: options.successBehavior || "close",
    });
  }, [pushRoute]);

  const confirmCurrentRoute = useCallback(async () => {
    // A second Enter while the first is still working would run it twice.
    if (currentRoute?.kind !== "confirm" || currentRoute.pending) return;
    updateTopRoute((route) => route.kind === "confirm"
      ? { ...route, pending: true, error: null }
      : route);
    try {
      await currentRoute.onConfirm();
      if (currentRoute.successBehavior === "back") {
        setRouteStack((current) => current.slice(0, -1));
      } else if (currentRoute.successBehavior !== "stay") {
        closeAll({ revertThemePreview: false });
      }
      currentRoute.onSuccess?.();
    } catch (error) {
      updateTopRoute((route) => route.kind === "confirm"
        ? {
          ...route,
          pending: false,
          error: error instanceof Error ? error.message : "Could not complete that action.",
        }
        : route);
    }
  }, [
    closeAll,
    currentRoute,
    setRouteStack,
    updateTopRoute,
  ]);

  return {
    confirmCurrentRoute,
    openInlineConfirm,
  };
}
