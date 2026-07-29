import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, ChoiceDialog, ConfirmDialog, Tabs } from "../../../components";
import { useAppSelector } from "../../../state/app/context";
import { useChartQueries, useFxRatesMap, useTickerFinancialsMap } from "../../../market-data/hooks";
import { selectEffectiveExchangeRates } from "../../../utils/exchange-rate-map";
import { blendHex, colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, Textarea, TextAttributes, type TextareaRenderable, useRendererHost, useUiHost } from "../../../ui";
import { useDialog, type AlertContext, type PromptContext } from "../../../ui/dialog";
import { openNativeSelect, type NativeSelectElement } from "../../../components/ui/native-select";
import { apiClient, type AccountProfile } from "../../../api-client";
import { chatController } from "../chat/controller";
import { CloudAuthNotice } from "../cloud/auth-actions";
import {
  AccountTextField,
  CheckboxRow,
  FieldRow,
  PublicAnalyticsGroup,
  accountFieldLabelWidth,
} from "./form-components";
import {
  NO_PORTFOLIO_VALUE,
  buildPublishedProfileAnalyticsPreview,
  buildProfileAnalyticsPreview,
  buildPortfolioChoices,
  computeCumulativeReturn,
  countPortfolioHoldings,
  emptyToNull,
  formatPlan,
  getPortfolioPositionTickers,
  portfolioOptionIds,
  profileToDraft,
  selectedPortfolioLabel,
  type AccountDraft,
  type AccountFieldKey,
} from "./model";
import { PasswordChangeDialog } from "./password-dialog";
import { useAccountManagementFooter } from "./footer";
import { useAccountManagementKeyboard } from "./keyboard";
import { buildTrackedCurrencies } from "../analytics/sector-model";
import {
  buildBenchmarkReturnSeries,
  buildPortfolioChartTargets,
  buildPortfolioReturnSeries,
} from "../analytics/pane-model";
import { computeDatedBeta } from "../analytics/metrics";
import { useCloudSyncStatus } from "../../../sync/react";
import { cloudSyncController } from "../../../sync/controller";
import { setSyncedProfileAnalytics } from "../../../sync/profile-analytics";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import {
  consumeRequestedAccountManagementTab,
  subscribeRequestedAccountManagementTab,
  type AccountManagementTab,
} from "./navigation";

type AccountBusy = "profile" | "password" | "alerts" | "billing" | "delete" | null;
const CLOUD_UPGRADE_URL = "https://gloom.sh/cloud?upgrade=pro";

const ACCOUNT_TAB_DEFS: Array<{ label: string; value: AccountManagementTab }> = [
  { label: "Profile", value: "profile" },
  { label: "Emails", value: "emails" },
  { label: "Pro", value: "pro" },
  { label: "Advanced", value: "advanced" },
];

const ACCOUNT_TAB_FIELD_ORDER: Record<AccountManagementTab, AccountFieldKey[]> = {
  profile: [
    "profilePublic",
    "acceptUnknownDms",
    "username",
    "name",
    "company",
    "title",
    "publicEmail",
    "xAccount",
    "bio",
    "sharedPortfolioId",
  ],
  emails: [
    "chatEmailNotificationsEnabled",
    "weeklyRoundupEnabled",
    "positionAlertsEnabled",
    "emailAlertsOffAction",
  ],
  pro: ["upgradeAction"],
  advanced: ["passwordAction", "deleteAccountAction"],
};

const PLAN_COMPARISON_ROWS = [
  { capability: "Market data", free: "Delayed", pro: "Real-time", proTone: "positive" },
  { capability: "News", free: "12h delay", pro: "Real-time wire", proTone: "positive" },
  { capability: "Cloud sync", free: "Included", pro: "Included", proTone: "neutral" },
  { capability: "X data", free: "No", pro: "Included", proTone: "positive" },
  { capability: "AI Screener", free: "No", pro: "Soon", proTone: "muted" },
] as const;

function PlanComparison({
  width,
  activePlan,
  upgradeButton,
}: {
  width: number;
  activePlan: "free" | "pro";
  upgradeButton: ReactNode;
}) {
  const isDesktop = useUiHost().kind === "desktop-web";
  const comparisonWidth = Math.min(width, 58);
  const capabilityWidth = Math.max(13, Math.min(16, Math.floor(comparisonWidth * 0.32)));
  const valueWidth = Math.max(10, Math.floor((comparisonWidth - capabilityWidth - 2) / 2));
  const rowWidth = capabilityWidth + valueWidth * 2 + 2;
  const proCellBg = blendHex(colors.panel, colors.selected, activePlan === "pro" ? 0.42 : 0.26);
  const freeFg = activePlan === "free" ? colors.text : colors.textDim;
  const proHeadingFg = activePlan === "pro" ? colors.textBright : colors.text;
  const proValueColor = (tone: typeof PLAN_COMPARISON_ROWS[number]["proTone"]) => {
    if (tone === "positive") return colors.positive;
    if (tone === "muted") return colors.textMuted;
    return colors.text;
  };

  if (isDesktop) {
    const gridStyle: CSSProperties = {
      display: "grid",
      gridTemplateColumns: width >= 86
        ? "minmax(220px, 1fr) minmax(120px, 0.42fr) minmax(300px, 1.05fr)"
        : "minmax(150px, 0.95fr) minmax(86px, 0.42fr) minmax(180px, 1fr)",
      columnGap: width >= 86 ? "clamp(30px, 5vw, 72px)" : "22px",
      alignItems: "center",
      width: "100%",
    };
    const desktopProBg = blendHex(colors.panel, colors.selected, activePlan === "pro" ? 0.34 : 0.24);
    const desktopProAltBg = blendHex(colors.panel, colors.selected, activePlan === "pro" ? 0.39 : 0.28);
    const desktopText = {
      lineHeight: "22px",
      fontSize: "15px",
    } satisfies CSSProperties;
    return (
      <Box
        flexDirection="column"
        width="100%"
        maxWidth={width >= 86 ? "980px" : "100%"}
        style={{
          marginTop: 18,
          paddingLeft: width >= 86 ? 12 : 4,
          paddingRight: width >= 86 ? 10 : 4,
        }}
      >
        <Box
          style={{
            ...gridStyle,
            marginBottom: 12,
          }}
        >
          <Text fg={colors.textDim} style={{ ...desktopText, fontWeight: 650 }}>
            {t("Capability")}
          </Text>
          <Text
            fg={activePlan === "free" ? colors.textBright : colors.textDim}
            attributes={activePlan === "free" ? TextAttributes.BOLD : 0}
            style={{ ...desktopText, fontWeight: activePlan === "free" ? 700 : 650 }}
          >
            {t("Free")}
          </Text>
          <Box flexDirection="row" alignItems="baseline" gap={1}>
            <Text
              fg={colors.borderFocused}
              attributes={TextAttributes.BOLD}
              style={{ ...desktopText, fontWeight: 750 }}
            >
              {t("Pro")}
            </Text>
            <Text fg={colors.textBright} style={desktopText}>
              {t("$49/mo")}
            </Text>
          </Box>
        </Box>
        {PLAN_COMPARISON_ROWS.map((row, index) => {
          const first = index === 0;
          const last = index === PLAN_COMPARISON_ROWS.length - 1;
          return (
            <Box
              key={row.capability}
              style={{
                ...gridStyle,
                minHeight: 48,
              }}
            >
              <Box flexDirection="row" alignItems="center" style={{ minWidth: 0 }}>
                <Box
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    marginRight: 18,
                    flexShrink: 0,
                    backgroundColor: colors.borderFocused,
                    boxShadow: `0 0 0 2px ${blendHex(colors.bg, colors.borderFocused, 0.14)}`,
                  }}
                />
                <Text fg={colors.textBright} style={{ ...desktopText, fontWeight: 520 }}>
                  {t(row.capability)}
                </Text>
              </Box>
              <Text fg={freeFg} style={desktopText}>
                {t(row.free)}
              </Text>
              <Box
                flexDirection="row"
                alignItems="center"
                backgroundColor={index % 2 === 0 ? desktopProBg : desktopProAltBg}
                style={{
                  minHeight: 48,
                  paddingLeft: width >= 86 ? 24 : 16,
                  paddingRight: width >= 86 ? 24 : 14,
                  borderTopLeftRadius: first ? 2 : 0,
                  borderTopRightRadius: first ? 2 : 0,
                  borderBottomLeftRadius: last ? 2 : 0,
                  borderBottomRightRadius: last ? 2 : 0,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.025)",
                }}
              >
                <Text
                  fg={proValueColor(row.proTone)}
                  attributes={row.proTone === "positive" ? TextAttributes.BOLD : 0}
                  style={{
                    ...desktopText,
                    fontWeight: row.proTone === "positive" ? 720 : 560,
                  }}
                >
                  {t(row.pro)}
                </Text>
              </Box>
            </Box>
          );
        })}
        <Box
          style={{
            ...gridStyle,
            marginTop: 14,
          }}
        >
          <Box />
          <Box />
          <Box flexDirection="row" justifyContent="center">
            {upgradeButton}
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={rowWidth}>
      <Box height={1} flexDirection="row" gap={1}>
        <Text width={capabilityWidth} fg={colors.textDim}>{t("Capability")}</Text>
        <Text width={valueWidth} fg={activePlan === "free" ? colors.textBright : colors.textDim} attributes={activePlan === "free" ? TextAttributes.BOLD : 0}>
          {t("Free")}
        </Text>
        <Box width={valueWidth} backgroundColor={proCellBg} paddingX={1}>
          <Text fg={proHeadingFg} attributes={TextAttributes.BOLD}>
            {`${t("Pro")} ${t("$49/mo")}`}
          </Text>
        </Box>
      </Box>
      {PLAN_COMPARISON_ROWS.map((row) => (
        <Box key={row.capability} height={1} flexDirection="row" gap={1}>
          <Text width={capabilityWidth} fg={colors.textDim}>{t(row.capability)}</Text>
          <Text width={valueWidth} fg={freeFg}>{t(row.free)}</Text>
          <Box width={valueWidth} backgroundColor={proCellBg} paddingX={1}>
            <Text fg={proValueColor(row.proTone)} attributes={row.proTone === "positive" ? TextAttributes.BOLD : 0}>
              {t(row.pro)}
            </Text>
          </Box>
        </Box>
      ))}
      <Box height={1} flexDirection="row" gap={1}>
        <Box width={capabilityWidth} />
        <Box width={valueWidth} />
        <Box width={valueWidth} flexDirection="row" paddingLeft={1}>
          {upgradeButton}
        </Box>
      </Box>
    </Box>
  );
}

export function AccountManagementPane({ focused, width, height }: PaneProps) {
  const language = useAppLanguage();
  const dialog = useDialog();
  const renderer = useRendererHost();
  const isDesktop = useUiHost().kind === "desktop-web";
  const config = useAppSelector((state) => state.config);
  const portfolios = config.portfolios;
  const baseCurrency = config.baseCurrency;
  const tickers = useAppSelector((state) => state.tickers);
  const cachedFinancials = useAppSelector((state) => state.financials);
  const cachedExchangeRates = useAppSelector((state) => state.exchangeRates);
  const [sessionMarker, setSessionMarker] = useState(() => {
    const snapshot = chatController.getSnapshot();
    return `${apiClient.getSessionToken() ?? ""}:${snapshot.user?.id ?? ""}:${snapshot.user?.username ?? ""}`;
  });
  const [hasSession, setHasSession] = useState(() => !!apiClient.getSessionToken());
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [draft, setDraft] = useState<AccountDraft>(() => profileToDraft(null));
  const [initialTab] = useState<AccountManagementTab>(
    () => consumeRequestedAccountManagementTab() ?? "profile",
  );
  const [activeField, setActiveField] = useState<AccountFieldKey>(
    () => ACCOUNT_TAB_FIELD_ORDER[initialTab][0] ?? "username",
  );
  const [message, setMessage] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<AccountBusy>(null);
  const [activeTab, setActiveTab] = useState<AccountManagementTab>(initialTab);

  useEffect(() => subscribeRequestedAccountManagementTab((tab) => {
    setActiveTab(tab);
    setActiveField(ACCOUNT_TAB_FIELD_ORDER[tab][0] ?? "username");
  }), []);
  const syncStatus = useCloudSyncStatus();
  const bioRef = useRef<TextareaRenderable | null>(null);
  const portfolioNativeSelectRef = useRef<NativeSelectElement | null>(null);
  const refreshedSyncRevisionRef = useRef<number | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const formWidth = Math.max(24, Math.min(70, width - 2));
  const contentWidth = activeTab === "pro" && isDesktop ? Math.max(formWidth, width - 2) : formWidth;
  const twoColumns = formWidth >= 60;
  const fieldWidth = twoColumns ? Math.max(22, Math.floor((formWidth - 3) / 2)) : Math.max(18, Math.min(46, formWidth - 2));
  const formLabelWidth = accountFieldLabelWidth(formWidth);
  const bodyHeight = Math.max(5, height);
  const fieldOrder = ACCOUNT_TAB_FIELD_ORDER[activeTab];
  const accountTabs = ACCOUNT_TAB_DEFS.map((tab) => ({ ...tab, label: t(tab.label) }));

  const portfolioHoldingCounts = useMemo(() => countPortfolioHoldings(tickers), [tickers]);
  const portfolioChoices = useMemo(
    () => buildPortfolioChoices(portfolios, portfolioHoldingCounts),
    [language, portfolioHoldingCounts, portfolios],
  );
  const selectedAnalyticsPortfolio = useMemo(
    () => portfolios.find((portfolio) => portfolio.id === draft.sharedPortfolioId) ?? null,
    [draft.sharedPortfolioId, portfolios],
  );
  const portfolioTickers = useMemo(
    () => draft.sharedPortfolioId ? getPortfolioPositionTickers(tickers, draft.sharedPortfolioId) : [],
    [draft.sharedPortfolioId, tickers],
  );
  const marketFinancials = useTickerFinancialsMap(portfolioTickers);
  const financials = useMemo(() => {
    const merged = new Map(cachedFinancials);
    for (const [symbol, data] of marketFinancials) {
      merged.set(symbol, data);
    }
    return merged;
  }, [cachedFinancials, marketFinancials]);
  const trackedCurrencies = useMemo(
    () => buildTrackedCurrencies(portfolioTickers, financials, baseCurrency),
    [baseCurrency, financials, portfolioTickers],
  );
  const fetchedExchangeRates = useFxRatesMap(trackedCurrencies);
  const effectiveExchangeRates = selectEffectiveExchangeRates(fetchedExchangeRates, cachedExchangeRates);
  const chartTargets = useMemo(
    () => buildPortfolioChartTargets(portfolioTickers),
    [portfolioTickers],
  );
  const chartRequests = useMemo(
    () => chartTargets.map((target) => target.request),
    [chartTargets],
  );
  const chartEntries = useChartQueries(chartRequests);
  const spyRequest = useMemo(
    () => ({
      instrument: { symbol: "SPY", exchange: "" },
      bufferRange: "1Y" as const,
      granularity: "range" as const,
    }),
    [],
  );
  const spyChartRequests = useMemo(
    () => portfolioTickers.length > 0 ? [spyRequest] : [],
    [portfolioTickers.length, spyRequest],
  );
  const spyChartEntries = useChartQueries(spyChartRequests);
  const columnContext = useMemo(() => ({
    activeTab: draft.sharedPortfolioId || undefined,
    baseCurrency,
    exchangeRates: effectiveExchangeRates,
    now: Date.now(),
  }), [baseCurrency, draft.sharedPortfolioId, effectiveExchangeRates]);
  const portfolioReturnSeries = useMemo(
    () => buildPortfolioReturnSeries({
      chartTargets,
      chartEntries,
      financials,
      columnContext,
    }),
    [chartEntries, chartTargets, columnContext, financials],
  );
  const spyReturnSeries = useMemo(
    () => buildBenchmarkReturnSeries(spyRequest, spyChartEntries),
    [spyChartEntries, spyRequest],
  );
  const oneYearReturn = useMemo(
    () => portfolioReturnSeries ? computeCumulativeReturn(portfolioReturnSeries) : null,
    [portfolioReturnSeries],
  );
  const beta = useMemo(
    () => (portfolioReturnSeries && spyReturnSeries ? computeDatedBeta(portfolioReturnSeries, spyReturnSeries) : null),
    [portfolioReturnSeries, spyReturnSeries],
  );
  const localAnalyticsPreview = useMemo(
    () => buildProfileAnalyticsPreview({
      beta,
      portfolio: selectedAnalyticsPortfolio,
      portfolioTickers,
      selectedPortfolioId: draft.sharedPortfolioId,
      oneYearReturn,
    }),
    [
      beta,
      draft.sharedPortfolioId,
      language,
      portfolioTickers,
      selectedAnalyticsPortfolio,
      oneYearReturn,
    ],
  );
  useEffect(() => {
    const portfolioId = selectedAnalyticsPortfolio?.id;
    if (!portfolioId) return;
    const changed = setSyncedProfileAnalytics(portfolioId, localAnalyticsPreview.publicAnalytics);
    if (changed) cloudSyncController.schedulePush("profile-analytics");
  }, [
    localAnalyticsPreview.publicAnalytics?.oneYearReturn,
    localAnalyticsPreview.publicAnalytics?.spyBeta,
    selectedAnalyticsPortfolio?.id,
  ]);
  const publicAnalyticsPreview = useMemo(
    () => buildPublishedProfileAnalyticsPreview({
      analytics: profile?.portfolioAnalytics ?? null,
      draftProfilePublic: draft.profilePublic,
      portfolio: selectedAnalyticsPortfolio,
      profileLoaded: !!profile,
      savedProfilePublic: profile?.profilePublic === true,
      savedSharedPortfolioId: profile?.sharedPortfolioId ?? "",
      selectedPortfolioId: draft.sharedPortfolioId,
      syncing: syncStatus.phase === "syncing",
    }),
    [
      draft.profilePublic,
      draft.sharedPortfolioId,
      language,
      profile,
      selectedAnalyticsPortfolio,
      syncStatus.phase,
    ],
  );
  const profileAnalyticsDetail = useMemo(() => {
    if (!draft.sharedPortfolioId) return t("No public portfolio analytics");
    if (!profile) return t("Loading published metrics");
    if (
      draft.profilePublic !== profile.profilePublic
      || draft.sharedPortfolioId !== (profile.sharedPortfolioId ?? "")
    ) {
      return t("Save profile to update published metrics");
    }
    if (profile.profilePublic !== true) return t("Public profile is off");
    if (syncStatus.phase === "syncing") return t("Syncing published metrics");
    if (!profile.portfolioAnalytics) return t("Waiting for published metrics");
    return t("Published public metrics");
  }, [
    draft.profilePublic,
    draft.sharedPortfolioId,
    language,
    profile,
    syncStatus.phase,
  ]);

  useEffect(() => {
    const unsubscribe = chatController.subscribe((snapshot) => {
      setHasSession(!!apiClient.getSessionToken() || snapshot.hasSavedSession);
      setSessionMarker(`${apiClient.getSessionToken() ?? ""}:${snapshot.user?.id ?? ""}:${snapshot.user?.username ?? ""}`);
    });
    void chatController.refreshSession().catch(() => {});
    return unsubscribe;
  }, []);

  const loadProfile = useCallback(async () => {
    if (!apiClient.getSessionToken()) {
      setProfile(null);
      setDraft(profileToDraft(null));
      return;
    }

    setMessage({ tone: "info", text: t("Loading account profile...") });
    try {
      const nextProfile = await apiClient.getAccountProfile();
      setProfile(nextProfile);
      setDraft(profileToDraft(nextProfile));
      setMessage(null);
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : t("Failed to load account profile."),
      });
    }
  }, []);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile, sessionMarker]);

  useEffect(() => {
    if (!hasSession || !apiClient.getSessionToken()) return;
    if (syncStatus.phase !== "synced" || syncStatus.revision == null) return;
    if (refreshedSyncRevisionRef.current === syncStatus.revision) return;
    refreshedSyncRevisionRef.current = syncStatus.revision;
    let cancelled = false;
    void (async () => {
      const nextProfile = await apiClient.getAccountProfile().catch(() => null);
      if (cancelled || !nextProfile) return;
      setProfile(nextProfile);
      await chatController.refreshSession().catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [hasSession, syncStatus.phase, syncStatus.revision]);

  useEffect(() => {
    if (!fieldOrder.includes(activeField)) {
      setActiveField(fieldOrder[0] ?? "username");
    }
  }, [activeField, fieldOrder]);

  const setDraftValue = useCallback(<K extends keyof AccountDraft>(key: K, value: AccountDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const selectTab = useCallback((tab: string) => {
    const nextTab = tab as AccountManagementTab;
    setActiveTab(nextTab);
    setActiveField(ACCOUNT_TAB_FIELD_ORDER[nextTab][0] ?? "username");
  }, []);

  const openPasswordDialog = useCallback(() => {
    if (busy) return;
    setActiveField("passwordAction");
    void dialog.alert({
      closeOnClickOutside: false,
      content: (context: AlertContext) => (
        <PasswordChangeDialog
          {...context}
          onChangePassword={async (currentPassword, newPassword) => {
            setBusy("password");
            setMessage({ tone: "info", text: t("Changing password...") });
            try {
              await apiClient.changePassword(currentPassword, newPassword);
              setMessage({ tone: "success", text: t("Password changed.") });
            } catch (error) {
              setMessage({
                tone: "error",
                text: error instanceof Error ? error.message : t("Failed to change password."),
              });
              throw error;
            } finally {
              setBusy(null);
            }
          }}
        />
      ),
    }).catch(() => {});
  }, [busy, dialog]);

  const openPortfolioDialog = useCallback(async () => {
    setActiveField("sharedPortfolioId");
    const currentPortfolioChoiceId = draftRef.current.sharedPortfolioId || NO_PORTFOLIO_VALUE;
    const selected = await dialog.prompt<string>({
      closeOnClickOutside: false,
      content: (context: PromptContext<string>) => (
        <ChoiceDialog
          {...context}
          title={t("Public Stats")}
          choices={portfolioChoices}
          selectedChoiceId={currentPortfolioChoiceId}
        />
      ),
    }).catch(() => "");
    if (!selected) return;
    setDraftValue("sharedPortfolioId", selected === NO_PORTFOLIO_VALUE ? "" : selected);
  }, [dialog, portfolioChoices, setDraftValue]);

  const openPortfolioPicker = useCallback(async () => {
    setActiveField("sharedPortfolioId");
    if (portfolioNativeSelectRef.current) {
      openNativeSelect(portfolioNativeSelectRef.current);
      return;
    }
    await openPortfolioDialog();
  }, [openPortfolioDialog]);

  const cycleField = useCallback((delta: number) => {
    setActiveField((current) => {
      const index = fieldOrder.indexOf(current);
      const nextIndex = Math.max(0, Math.min(fieldOrder.length - 1, index + delta));
      return fieldOrder[nextIndex] ?? "username";
    });
  }, [fieldOrder]);

  const cyclePortfolio = useCallback((delta: number) => {
    const optionIds = portfolioOptionIds(portfolios);
    const currentValue = draftRef.current.sharedPortfolioId || NO_PORTFOLIO_VALUE;
    const currentIndex = Math.max(0, optionIds.indexOf(currentValue));
    const nextIndex = (currentIndex + delta + optionIds.length) % optionIds.length;
    const nextValue = optionIds[nextIndex] ?? NO_PORTFOLIO_VALUE;
    setDraftValue("sharedPortfolioId", nextValue === NO_PORTFOLIO_VALUE ? "" : nextValue);
  }, [portfolios, setDraftValue]);

  const saveProfile = useCallback(async () => {
    const current = draftRef.current;
    const bio = bioRef.current?.editBuffer.getText() ?? current.bio;
    if (!current.username.trim() || !current.name.trim()) {
      setMessage({ tone: "error", text: t("Username and full name are required.") });
      return;
    }

    setBusy("profile");
    setMessage({ tone: "info", text: t("Saving account profile...") });
    try {
      const nextProfile = await apiClient.updateAccountProfile({
        username: current.username,
        name: current.name,
        company: emptyToNull(current.company),
        title: emptyToNull(current.title),
        bio: emptyToNull(bio),
        profilePublic: current.profilePublic,
        publicEmail: emptyToNull(current.publicEmail),
        xAccount: emptyToNull(current.xAccount),
        sharedPortfolioId: emptyToNull(current.sharedPortfolioId),
        acceptUnknownDms: current.acceptUnknownDms,
        chatEmailNotificationsEnabled: current.chatEmailNotificationsEnabled,
        weeklyRoundupEnabled: current.weeklyRoundupEnabled,
        positionAlertsEnabled: current.positionAlertsEnabled,
      });
      setProfile(nextProfile);
      setDraft(profileToDraft(nextProfile));
      await chatController.refreshSession().catch(() => {});
      setMessage({ tone: "success", text: t("Account profile saved.") });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : t("Failed to save account profile."),
      });
    } finally {
      setBusy(null);
    }
  }, []);

  const turnOffEmailAlerts = useCallback(async () => {
    setActiveField("emailAlertsOffAction");
    setBusy("alerts");
    setMessage({ tone: "info", text: t("Turning off email alerts...") });
    try {
      const nextProfile = await apiClient.updateAccountProfile({
        chatEmailNotificationsEnabled: false,
        weeklyRoundupEnabled: false,
        positionAlertsEnabled: false,
      });
      setDraft((current) => ({
        ...current,
        chatEmailNotificationsEnabled: nextProfile.chatEmailNotificationsEnabled,
        weeklyRoundupEnabled: nextProfile.weeklyRoundupEnabled,
        positionAlertsEnabled: nextProfile.positionAlertsEnabled,
      }));
      setProfile(nextProfile);
      setMessage({ tone: "success", text: t("Email alerts are off.") });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : t("Failed to update alert settings."),
      });
    } finally {
      setBusy(null);
    }
  }, []);

  const openUpgrade = useCallback(() => {
    setActiveField("upgradeAction");
    setBusy("billing");
    setMessage({ tone: "info", text: t("Opening Pro upgrade...") });
    void renderer.openExternal(CLOUD_UPGRADE_URL)
      .then(() => setMessage(null))
      .catch((error) => {
        setMessage({
          tone: "error",
          text: error instanceof Error ? error.message : t("Failed to open upgrade page."),
        });
      })
      .finally(() => setBusy(null));
  }, [renderer]);

  const deleteAccount = useCallback(async () => {
    setActiveField("deleteAccountAction");
    if (busy) return;
    const confirmed = await dialog.prompt<boolean>({
      closeOnClickOutside: false,
      content: (context: PromptContext<boolean>) => (
        <ConfirmDialog
          {...context}
          title={t("Delete Account")}
          body={[
            t("Delete your Gloom Cloud account?"),
            t("This removes cloud profile, chat, sync, and billing-linked account data."),
          ]}
          confirmLabel={t("Delete Account")}
          confirmVariant="danger"
        />
      ),
    }).catch(() => false);
    if (!confirmed) return;

    setBusy("delete");
    setMessage({ tone: "info", text: t("Deleting account...") });
    try {
      await apiClient.deleteAccount();
      setProfile(null);
      setDraft(profileToDraft(null));
      setHasSession(false);
      await chatController.refreshSession().catch(() => {});
      setMessage({ tone: "success", text: t("Account deleted.") });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : t("Failed to delete account."),
      });
    } finally {
      setBusy(null);
    }
  }, [busy, dialog]);

  useAccountManagementFooter({
    busy,
    draft,
    hasSession,
    message,
    profile,
    saveProfile,
  });

  useAccountManagementKeyboard({
    activeField,
    cycleField,
    cyclePortfolio,
    deleteAccount,
    draftRef,
    focused,
    openPasswordDialog,
    openPortfolioDialog: openPortfolioPicker,
    openUpgrade,
    saveProfile,
    setDraftValue,
    turnOffEmailAlerts,
  });

  if (!hasSession && !apiClient.getSessionToken()) {
    return (
      <Box padding={1}>
        <CloudAuthNotice message={t("Log in to manage your Gloom Cloud account.")} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} gap={1}>
      <Tabs
        tabs={accountTabs}
        activeValue={activeTab}
        onSelect={selectTab}
        focused={focused}
        variant="pill"
        compact
        keyboardNavigation={false}
      />
      <ScrollBox height={Math.max(3, bodyHeight - 2)} scrollY focusable={false}>
        <Box flexDirection="column" width={contentWidth} gap={1}>
          {activeTab === "profile" ? (
            <>
              <FieldRow twoColumns={twoColumns}>
                <CheckboxRow
                  label={t("Public Profile")}
                  checked={draft.profilePublic}
                  active={activeField === "profilePublic"}
                  width={fieldWidth}
                  onFocus={() => setActiveField("profilePublic")}
                  onChange={(checked) => setDraftValue("profilePublic", checked)}
                />
                <CheckboxRow
                  label={t("Incoming DMs")}
                  checked={draft.acceptUnknownDms}
                  active={activeField === "acceptUnknownDms"}
                  width={fieldWidth}
                  onFocus={() => setActiveField("acceptUnknownDms")}
                  onChange={(checked) => setDraftValue("acceptUnknownDms", checked)}
                />
              </FieldRow>

              <FieldRow twoColumns={twoColumns}>
                <AccountTextField
                  fieldKey="username"
                  label={t("Username")}
                  value={draft.username}
                  placeholder={t("username")}
                  activeField={activeField}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={setActiveField}
                  onChange={(value) => setDraftValue("username", value)}
                  onSubmit={() => { void saveProfile(); }}
                />
                <AccountTextField
                  fieldKey="name"
                  label={t("Full Name")}
                  value={draft.name}
                  placeholder={t("Full name")}
                  activeField={activeField}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={setActiveField}
                  onChange={(value) => setDraftValue("name", value)}
                  onSubmit={() => { void saveProfile(); }}
                />
              </FieldRow>

              <FieldRow twoColumns={twoColumns}>
                <AccountTextField
                  fieldKey="company"
                  label={t("Company")}
                  value={draft.company}
                  placeholder={t("Company")}
                  activeField={activeField}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={setActiveField}
                  onChange={(value) => setDraftValue("company", value)}
                  onSubmit={() => { void saveProfile(); }}
                />
                <AccountTextField
                  fieldKey="title"
                  label={t("Title")}
                  value={draft.title}
                  placeholder={t("Title")}
                  activeField={activeField}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={setActiveField}
                  onChange={(value) => setDraftValue("title", value)}
                  onSubmit={() => { void saveProfile(); }}
                />
              </FieldRow>

              <FieldRow twoColumns={twoColumns}>
                <AccountTextField
                  fieldKey="publicEmail"
                  label={t("Public Email")}
                  value={draft.publicEmail}
                  placeholder="public@example.com"
                  activeField={activeField}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={setActiveField}
                  onChange={(value) => setDraftValue("publicEmail", value)}
                  onSubmit={() => { void saveProfile(); }}
                />
                <AccountTextField
                  fieldKey="xAccount"
                  label={t("X Account")}
                  value={draft.xAccount}
                  placeholder={t("handle")}
                  activeField={activeField}
                  focused={focused}
                  width={fieldWidth}
                  onFocus={setActiveField}
                  onChange={(value) => setDraftValue("xAccount", value)}
                  onSubmit={() => { void saveProfile(); }}
                />
              </FieldRow>

              <Box
                flexDirection="row"
                width={formWidth}
                gap={1}
                onMouseDown={() => setActiveField("bio")}
              >
                <Text
                  width={formLabelWidth}
                  fg={activeField === "bio" ? colors.textBright : colors.textDim}
                  attributes={activeField === "bio" ? TextAttributes.BOLD : 0}
                >
                  {activeField === "bio" ? `> ${t("Bio")}` : `  ${t("Bio")}`}
                </Text>
                <Box
                  height={3}
                  width={Math.max(18, formWidth - formLabelWidth - 1)}
                  border
                  borderColor={activeField === "bio" ? colors.borderFocused : colors.border}
                  backgroundColor={colors.panel}
                  style={{
                    borderRadius: 6,
                    overflow: "hidden",
                  }}
                >
                  <Textarea
                    key={`bio:${profile?.updatedAt ?? "empty"}`}
                    ref={bioRef}
                    initialValue={draft.bio}
                    placeholder={t("Short profile bio")}
                    focused={focused && activeField === "bio"}
                    textColor={colors.text}
                    placeholderColor={colors.textDim}
                    backgroundColor={colors.panel}
                    flexGrow={1}
                    wrapText
                    onInput={(value: string) => setDraftValue("bio", value)}
                  />
                </Box>
              </Box>

              <PublicAnalyticsGroup
                preview={publicAnalyticsPreview}
                choices={portfolioChoices}
                value={draft.sharedPortfolioId || NO_PORTFOLIO_VALUE}
                label={selectedPortfolioLabel(portfolios, draft.sharedPortfolioId)}
                detail={profileAnalyticsDetail}
                active={activeField === "sharedPortfolioId"}
                width={formWidth}
                disclaimer={draft.sharedPortfolioId ? t("Only 1Y return and SPY Beta are shared. Positions are not shared.") : null}
                selectRef={(element) => {
                  portfolioNativeSelectRef.current = element;
                }}
                onFocus={() => setActiveField("sharedPortfolioId")}
                onSelect={(selected) => {
                  setActiveField("sharedPortfolioId");
                  setDraftValue("sharedPortfolioId", selected === NO_PORTFOLIO_VALUE ? "" : selected);
                }}
                onOpen={() => { void openPortfolioPicker(); }}
              />

              <Box flexDirection="row" gap={1}>
                <Button label={busy === "profile" ? t("Saving...") : t("Save Profile")} variant="primary" onPress={() => { void saveProfile(); }} disabled={!!busy} />
              </Box>
            </>
          ) : null}

          {activeTab === "emails" ? (
            <>
              <CheckboxRow
                label={t("Offline Chat")}
                checked={draft.chatEmailNotificationsEnabled}
                active={activeField === "chatEmailNotificationsEnabled"}
                description={t("Replies and private messages while offline.")}
                width={formWidth}
                onFocus={() => setActiveField("chatEmailNotificationsEnabled")}
                onChange={(checked) => setDraftValue("chatEmailNotificationsEnabled", checked)}
              />
              <CheckboxRow
                label={t("Weekly Roundup")}
                checked={draft.weeklyRoundupEnabled}
                active={activeField === "weeklyRoundupEnabled"}
                description={t("Friday after market close.")}
                width={formWidth}
                onFocus={() => setActiveField("weeklyRoundupEnabled")}
                onChange={(checked) => setDraftValue("weeklyRoundupEnabled", checked)}
              />
              <CheckboxRow
                label={t("Smart Alerts")}
                checked={draft.positionAlertsEnabled}
                active={activeField === "positionAlertsEnabled"}
                description={t("Unusual portfolio or watchlist moves.")}
                width={formWidth}
                onFocus={() => setActiveField("positionAlertsEnabled")}
                onChange={(checked) => setDraftValue("positionAlertsEnabled", checked)}
              />
              <Box flexDirection="row" gap={1} style={{ marginTop: 8 }}>
                <Button
                  label={busy === "alerts" ? t("Turning Off...") : t("Turn Off All")}
                  active={activeField === "emailAlertsOffAction"}
                  onPress={() => { void turnOffEmailAlerts(); }}
                  disabled={!!busy || (
                    !draft.chatEmailNotificationsEnabled
                    && !draft.weeklyRoundupEnabled
                    && !draft.positionAlertsEnabled
                  )}
                />
                <Button label={busy === "profile" ? t("Saving...") : t("Save")} variant="primary" onPress={() => { void saveProfile(); }} disabled={!!busy} />
              </Box>
            </>
          ) : null}

          {activeTab === "pro" ? (
            <>
              <Box flexDirection="row" gap={1}>
                <Text fg={colors.textDim}>{t("Status")}</Text>
                <Text fg={profile?.plan === "pro" ? colors.positive : colors.textBright} attributes={TextAttributes.BOLD}>
                  {formatPlan(profile?.plan)}
                </Text>
                {profile?.email ? <Text fg={colors.textMuted}>{profile.email}</Text> : null}
              </Box>
              <PlanComparison
                width={contentWidth}
                activePlan={profile?.plan === "pro" ? "pro" : "free"}
                upgradeButton={(
                  <Button
                    label={profile?.plan === "pro" ? t("Manage Pro") : busy === "billing" ? t("Opening...") : t("Upgrade to Pro")}
                    variant={profile?.plan === "pro" ? "secondary" : "primary"}
                    width={isDesktop ? 28 : undefined}
                    height={isDesktop ? "28px" : undefined}
                    active={activeField === "upgradeAction"}
                    onPress={openUpgrade}
                    disabled={!!busy}
                  />
                )}
              />
            </>
          ) : null}

          {activeTab === "advanced" ? (
            <>
              <Box flexDirection="row" gap={1}>
                <Button
                  label={t("Change Password")}
                  active={activeField === "passwordAction"}
                  onPress={openPasswordDialog}
                  disabled={!!busy}
                />
                <Button
                  label={busy === "delete" ? t("Deleting...") : t("Delete Account")}
                  variant="danger"
                  active={activeField === "deleteAccountAction"}
                  onPress={() => { void deleteAccount(); }}
                  disabled={!!busy}
                />
              </Box>
            </>
          ) : null}
          <Box height={1} />
        </Box>
      </ScrollBox>
    </Box>
  );
}
