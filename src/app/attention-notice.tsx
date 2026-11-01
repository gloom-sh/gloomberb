import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiClient } from "../api-client";
import { t } from "../i18n";
import { useAppActive } from "../state/app/activity";
import { useAppDispatch, useAppGetState, useAppSelector } from "../state/app/context";
import { scheduleConfigSave } from "../state/config-save-scheduler";
import { cloudSyncController } from "../sync/controller";
import { attentionCollectionAvailable } from "../telemetry/attention-counts";
import { ATTENTION_OFF_MESSAGE, attentionNoticeDue, withAttentionNoticeShown } from "../telemetry/attention-setting";
import { reportTelemetryConfig } from "../telemetry/live-config";
import type { TelemetryConfig } from "../types/config";
import type { AppNotificationRequest } from "../types/plugin";

/**
 * The whole notice, with no title: the terminal draws none, and it has to
 * name the setting its Turn off acts on and say plainly what leaves the app.
 */
const ATTENTION_NOTICE_TEXT = "Attention Counts is now on. Tickers you open are sent to Gloom with your account; only hourly totals of 20+ people are published.";

/** The signed-in account with a verified email, or null; the same account the collector counts for. */
function verifiedAccount(): string | null {
  return apiClient.getVerifiedSessionIdentity() ? apiClient.getCurrentUser()?.id ?? null : null;
}

/** Where the account's synced settings come from; whether they were pulled this session. */
export interface AccountSettingsSource {
  subscribe(listener: () => void): () => void;
  getStatus(): { lastPullAt: string | null };
}

/**
 * The one-time notice that Attention Counts is on by default: a toast that
 * stays until dismissed, with Turn off. It shows once per account on this
 * installation, while the app is in front, to a verified account whose
 * setting is untouched, and only after this session has pulled the
 * account's synced settings, so an off made on another device arrives
 * before it. Nothing is counted under the default until the toast has been
 * drawn for that account; an explicit on or off never sees it.
 */
export function AttentionCountsNotice({
  notify,
  accountSettings = cloudSyncController,
}: {
  notify(request: AppNotificationRequest): void;
  accountSettings?: AccountSettingsSource;
}) {
  const dispatch = useAppDispatch();
  const getState = useAppGetState();
  const telemetry = useAppSelector((state) => state.config.telemetry);
  const account = useSyncExternalStore((onChange) => apiClient.subscribeCurrentUser(onChange), verifiedAccount, verifiedAccount);
  const pulled = useSyncExternalStore(
    (onChange) => accountSettings.subscribe(onChange),
    () => accountSettings.getStatus().lastPullAt !== null,
    () => accountSettings.getStatus().lastPullAt !== null,
  );
  const onScreen = useAppActive();
  /** Accounts this session already showed it to, so a re-render never stacks a second toast. */
  const asked = useRef(new Set<string>());
  const due = pulled && attentionNoticeDue(telemetry, account) && attentionCollectionAvailable();

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
      body: t(ATTENTION_NOTICE_TEXT),
      type: "info",
      persistent: true,
      action: {
        label: t("Turn off"),
        onClick: () => {
          save((current) => ({ ...current, attention: false }));
          notify({ body: t(ATTENTION_OFF_MESSAGE), type: "success" });
        },
      },
      onShown: () => {
        if (verifiedAccount() === account) save((current) => withAttentionNoticeShown(current, account));
      },
    });
  }, [account, dispatch, due, getState, notify, onScreen]);

  return null;
}
