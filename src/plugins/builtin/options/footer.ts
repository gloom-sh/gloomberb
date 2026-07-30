import { useCallback, useMemo } from "react";
import type { PaneFooterSegment } from "../../../components";
import { apiClient } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { useShortcut } from "../../../react/input";
import type { OptionsChain } from "../../../types/financials";
import { useRendererHost } from "../../../ui";
import { CLOUD_UPGRADE_URL } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../shared/pane-footer";

export interface OptionsAccessFooterState {
  canUpgrade: boolean;
  text: string;
  tone: "positive" | "warning";
}

export function resolveOptionsAccessFooterState({
  chain,
  clientPlan,
  hasLiveQuote,
}: {
  chain: OptionsChain | null | undefined;
  clientPlan: "free" | "pro" | null;
  hasLiveQuote: boolean;
}): OptionsAccessFooterState {
  if (clientPlan !== "pro") {
    const delayMinutes = chain?.delayMinutes && chain.delayMinutes > 0 ? chain.delayMinutes : 15;
    return {
      canUpgrade: true,
      text: tf("{count}-minute delayed options, upgrade for real-time", {
        count: delayMinutes,
      }),
      tone: "warning",
    };
  }

  if (hasLiveQuote) {
    return {
      canUpgrade: false,
      text: t("real-time options"),
      tone: "positive",
    };
  }

  return {
    canUpgrade: false,
    text: t("options delayed fallback"),
    tone: "warning",
  };
}

export function buildOptionsAccessFooterSegment(
  state: OptionsAccessFooterState,
  openUpgrade: () => void,
): PaneFooterSegment {
  return {
    id: "options-access",
    ...(state.canUpgrade ? { onPress: openUpgrade } : {}),
    parts: [{ text: state.text, tone: state.tone }],
  };
}

export function useOptionsAccessFooter({
  chain,
  error,
  focused,
  hasLiveQuote,
  loading,
}: {
  chain: OptionsChain | null | undefined;
  error?: string | null;
  focused: boolean;
  hasLiveQuote: boolean;
  loading?: boolean;
}): OptionsAccessFooterState {
  const rendererHost = useRendererHost();
  const user = apiClient.getCurrentUser();
  const clientPlan = user?.emailVerified === true && user.plan === "pro" ? "pro" : "free";
  const state = resolveOptionsAccessFooterState({
    chain,
    clientPlan,
    hasLiveQuote,
  });
  const openUpgrade = useCallback(() => {
    void rendererHost.openExternal(CLOUD_UPGRADE_URL);
  }, [rendererHost]);

  useShortcut(
    (event) => {
      const key = (event.name ?? event.key ?? "").toLowerCase();
      if (!focused || !state.canUpgrade || key !== "u") return;
      event.stopPropagation();
      event.preventDefault();
      openUpgrade();
    },
    { scope: "options:upgrade" },
  );

  const info = useMemo(
    () => [buildOptionsAccessFooterSegment(state, openUpgrade)],
    [openUpgrade, state.canUpgrade, state.text, state.tone],
  );
  usePaneStatusFooter({
    registrationId: "options",
    loading,
    error,
    info,
  });
  return state;
}
