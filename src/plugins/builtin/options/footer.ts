import { useCallback, useMemo } from "react";
import type { PaneFooterSegment } from "../../../components";
import { apiClient } from "../../../api-client";
import { t, tf } from "../../../i18n";
import { useShortcut } from "../../../react/input";
import type { OptionsChain } from "../../../types/financials";
import { useRendererHost } from "../../../ui";
import { CLOUD_UPGRADE_URL } from "../shared/cloud-upgrade";
import { usePaneStatusFooter } from "../shared/pane-footer";
import type { OptionQuoteCoverage } from "./live-quotes";

export interface OptionsAccessFooterState {
  canUpgrade: boolean;
  text: string;
  tone: "muted" | "positive" | "warning";
}

export function resolveOptionsAccessFooterState({
  chain,
  clientPlan,
  quoteCoverage,
}: {
  chain: OptionsChain | null | undefined;
  clientPlan: "free" | "pro" | null;
  quoteCoverage: Pick<OptionQuoteCoverage, "status">;
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

  if (quoteCoverage.status === "live") {
    return {
      canUpgrade: false,
      text: t("real-time options"),
      tone: "positive",
    };
  }
  if (quoteCoverage.status === "mixed") {
    return {
      canUpgrade: false,
      text: t("mixed real-time and delayed options"),
      tone: "warning",
    };
  }
  if (quoteCoverage.status === "connecting") {
    return {
      canUpgrade: false,
      text: t("connecting real-time options"),
      tone: "muted",
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
  loading,
  quoteCoverage,
}: {
  chain: OptionsChain | null | undefined;
  error?: string | null;
  focused: boolean;
  loading?: boolean;
  quoteCoverage: Pick<OptionQuoteCoverage, "status">;
}): OptionsAccessFooterState {
  const rendererHost = useRendererHost();
  const user = apiClient.getCurrentUser();
  const clientPlan = user?.emailVerified === true && user.plan === "pro" ? "pro" : "free";
  const state = resolveOptionsAccessFooterState({
    chain,
    clientPlan,
    quoteCoverage,
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
