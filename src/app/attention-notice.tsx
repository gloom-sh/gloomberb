import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiClient } from "../api-client";
import { t } from "../i18n";
import { useAppActive } from "../state/app/activity";
import { useAppDispatch, useAppGetState, useAppSelector } from "../state/app/context";
import { scheduleConfigSave } from "../state/config-save-scheduler";
import { attentionCollectionAvailable } from "../telemetry/attention-counts";
import { attentionNoticeDue, withAttentionNoticeShown } from "../telemetry/attention-setting";
import { reportTelemetryConfig } from "../telemetry/live-config";
import type { TelemetryConfig } from "../types/config";
import type { AppNotificationRequest } from "../types/plugin";

const ATTENTION_NOTICE_TITLE = "Attention Counts is on";
/** The whole notice in the terminal, which draws no toast titles. */
const ATTENTION_NOTICE_TEXT = "Tickers you open are only shared as totals of 20+ people per stock-hour, never per person.";

/** The signed-in account with a verified email, or null; the same account the collector counts for. */
function verifiedAccount(): string | null {
  return apiClient.getVerifiedSessionIdentity() ? apiClient.getCurrentUser()?.id ?? null : null;
}

/**
 * The one-time notice that Attention Counts is on by default: a toast that
 * stays until dismissed, with Turn off. It shows once per account on this
 * installation, while the app is in front, to a verified account whose
 * setting is untouched. Nothing is counted under the default until the toast
 * has been drawn for that account; an explicit on or off never sees it.
 */
export function AttentionCountsNotice({ notify }: { notify(request: AppNotificationRequest): void }) {
  const dispatch = useAppDispatch();
  const getState = useAppGetState();
  const telemetry = useAppSelector((state) => state.config.telemetry);
  const account = useSyncExternalStore((onChange) => apiClient.subscribeCurrentUser(onChange), verifiedAccount, verifiedAccount);
  const onScreen = useAppActive();
  /** Accounts this session already showed it to, so a re-render never stacks a second toast. */
  const asked = useRef(new Set<string>());
  const due = attentionNoticeDue(telemetry, account) && attentionCollectionAvailable();

  useEffect(() => {
    if (!due || !onScreen || !account || asked.current.has(account)) return;
    asked.current.add(account);
    const save = (change: (telemetry: TelemetryConfig | undefined) => TelemetryConfig | undefined) => {
      const current = getState().config;
      const next = change(current.telemetry);
      if (next === current.telemetry) return;
      // Reported first, so turning off drops unsent counts before React commits.
      reportTelemetryConfig(next);
      dispatch({ type: "SET_CONFIG", config: { ...current, telemetry: next } });
      scheduleConfigSave(() => {
        const state = getState();
        return { ...state.config, recentTickers: state.recentTickers };
      });
    };
    notify({
      title: t(ATTENTION_NOTICE_TITLE),
      body: t(ATTENTION_NOTICE_TEXT),
      type: "info",
      persistent: true,
      action: {
        label: t("Turn off"),
        onClick: () => {
          save((current) => ({ ...current, attention: false }));
          notify({ body: `${t("Attention Counts")}: ${t("off")}`, type: "success" });
        },
      },
      onShown: () => {
        if (verifiedAccount() === account) save((current) => withAttentionNoticeShown(current, account));
      },
    });
  }, [account, dispatch, due, getState, notify, onScreen]);

  return null;
}
