import { Box, SpinnerMark, Text, TextAttributes, useRendererHost, useUiCapabilities } from "../../ui";
import { useCallback, useEffect, type ReactNode } from "react";
import { blendHex, priceColor } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { useAppActive } from "../../state/app/activity";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import {
  selectBaseCurrency,
  selectUpdateAvailable,
  selectUpdateCheckInProgress,
  selectUpdateNotice,
  selectUpdateProgress,
} from "../../state/selectors-ui";
import { getSharedMarketDataCoordinator } from "../../market-data/coordinator";
import { t, tf } from "../../i18n";
import { useQuoteEntry, useResolvedEntryValue } from "../../market-data/hooks";
import { formatPercentRaw } from "../../utils/format";
import { formatMarketPrice } from "../../market-data/market/format";
import { marketStateLabel, marketStateColor, getActiveQuoteDisplay } from "../../market-data/market/status";
import { VERSION } from "../../version";
import { getTitlebarLeadingInset } from "./titlebar-overlay";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";

const SPY_REFRESH_MS = 5 * 60_000; // 5 min
const UPDATE_NOTICE_DURATION_MS = 5_000;

function DesktopHeaderPill({
  children,
  backgroundColor,
  borderColor,
}: {
  children: ReactNode;
  backgroundColor?: string;
  borderColor?: string;
}) {
  const colors = useThemeColors();
  const resolvedBackgroundColor = backgroundColor ?? blendHex(colors.header, colors.bg, 0.28);
  const resolvedBorderColor = borderColor ?? blendHex(colors.border, colors.headerText, 0.22);
  return (
    <Box
      height={1}
      flexDirection="row"
      alignItems="center"
      backgroundColor={resolvedBackgroundColor}
      style={{
        border: `1px solid ${resolvedBorderColor}`,
        borderRadius: 5,
        paddingInline: 6,
      }}
    >
      {children}
    </Box>
  );
}

function UpdateStatus() {
  const colors = useThemeColors();
  const dispatch = useAppDispatch();
  const updateAvailable = useAppSelector(selectUpdateAvailable);
  const updateProgress = useAppSelector(selectUpdateProgress);
  const updateCheckInProgress = useAppSelector(selectUpdateCheckInProgress);
  const updateNotice = useAppSelector(selectUpdateNotice);

  useEffect(() => {
    if (!updateNotice || updateAvailable || updateProgress || updateCheckInProgress) return;
    const timeout = setTimeout(() => {
      dispatch({ type: "SET_UPDATE_NOTICE", notice: null });
    }, UPDATE_NOTICE_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [dispatch, updateAvailable, updateCheckInProgress, updateNotice, updateProgress]);

  if (updateProgress) {
    if (updateProgress.phase === "downloading") {
      return (
        <Box flexDirection="row" gap={1}>
          <SpinnerMark name="dots" color={colors.headerText} />
          <Text fg={colors.headerText}>
            {tf("Downloading v{version}: {percent}%", {
              version: updateAvailable?.version ?? "",
              percent: updateProgress.percent ?? 0,
            })}
          </Text>
        </Box>
      );
    }
    if (updateProgress.phase === "replacing") {
      return (
        <Box flexDirection="row" gap={1}>
          <SpinnerMark name="dots" color={colors.headerText} />
          <Text fg={colors.headerText}>{t("Installing update...")}</Text>
        </Box>
      );
    }
    if (updateProgress.phase === "done") {
      return <Text fg={colors.headerText}>{t(updateProgress.message ?? "Update installed, restart to apply")}</Text>;
    }
    if (updateProgress.phase === "error") {
      return <Text fg={colors.headerText}>{tf("Update failed: {error}", { error: updateProgress.error ?? "Unknown error" })}</Text>;
    }
  }

  if (updateCheckInProgress) {
    return (
      <Box flexDirection="row" gap={1}>
        <SpinnerMark name="dots" color={colors.headerText} />
        <Text fg={colors.headerText}>{t("Checking for updates...")}</Text>
      </Box>
    );
  }

  if (updateAvailable) {
    if (updateAvailable.updateAction.kind === "manual") {
      return (
        <Text fg={colors.headerText}>
          {tf("v{version} available — run {command}", {
            version: updateAvailable.version,
            command: updateAvailable.updateAction.command,
          })}
        </Text>
      );
    }
    return (
      <Text fg={colors.headerText}>
        {tf("v{version} available — starting download...", { version: updateAvailable.version })}
      </Text>
    );
  }

  if (updateNotice) {
    return <Text fg={colors.headerText}>{updateNotice}</Text>;
  }

  return null;
}

export function Header({ onOpenHelp }: { onOpenHelp?: () => void }) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const baseCurrency = useAppSelector(selectBaseCurrency);
  const appActive = useAppActive();
  const { titleBarOverlay, windowControls } = useUiCapabilities();
  const showWindowControls = windowControls === "windows";
  const titlebarLeadingInset = titleBarOverlay ? getTitlebarLeadingInset() : 0;
  const spyQuoteEntry = useQuoteEntry("SPY", null);
  const spyQuote = useResolvedEntryValue(spyQuoteEntry);

  useEffect(() => {
    if (!appActive) return;
    const coordinator = getSharedMarketDataCoordinator();
    if (!coordinator) return;
    const fetchSpy = async () => {
      await coordinator.loadQuote({ symbol: "SPY" }).catch(() => {});
    };
    fetchSpy();
    const id = setInterval(fetchSpy, SPY_REFRESH_MS);
    return () => { clearInterval(id); };
  }, [appActive]);

  const activeSpyQuote = getActiveQuoteDisplay(spyQuote);
  const spyColor = activeSpyQuote ? priceColor(activeSpyQuote.change, colors) : colors.headerText;
  const spyText = activeSpyQuote
    ? `SPY ${formatMarketPrice(activeSpyQuote.price, { assetCategory: "ETF" })} ${formatPercentRaw(activeSpyQuote.changePercent)}`
    : "SPY —";

  const startWindowDrag = useCallback(() => {
    if (!titleBarOverlay) return;
    void rendererHost.startWindowDrag?.();
  }, [rendererHost, titleBarOverlay]);

  // Market status
  const mktState = spyQuote?.marketState;
  const mktLabel = mktState ? t(marketStateLabel(mktState)) : "";
  const mktColor = mktState ? marketStateColor(mktState, colors) : colors.headerText;

  const openHelp = useCallback((event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    onOpenHelp?.();
  }, [onOpenHelp]);

  if (titleBarOverlay) {
    return (
      <Box
        flexDirection="row"
        height={1}
        alignItems="center"
        backgroundColor={colors.header}
        data-gloom-role="app-header"
        data-titlebar-overlay="true"
        onMouseDown={startWindowDrag}
        style={{
          boxShadow: `0 -1px 0 ${colors.header}, inset 0 1px 0 ${colors.header}`,
          paddingLeft: 8,
          paddingRight: showWindowControls ? 0 : 12,
          position: "relative",
        }}
      >
        <Box paddingLeft={titlebarLeadingInset} flexDirection="row" alignItems="center" gap={1}>
          <Text attributes={TextAttributes.BOLD} fg={colors.headerText}>
            Gloomberb
          </Text>
          <DesktopHeaderPill
            backgroundColor={blendHex(colors.header, colors.headerText, 0.1)}
            borderColor={blendHex(colors.border, colors.headerText, 0.28)}
          >
            <Text fg={colors.headerText} style={{ fontSize: 11 }}>v{VERSION}</Text>
          </DesktopHeaderPill>
        </Box>
        <Box flexGrow={1} paddingLeft={2} paddingRight={2} minWidth={0}>
          <UpdateStatus />
        </Box>
        {onOpenHelp ? (
          <Box
            height={1}
            flexDirection="row"
            alignItems="center"
            data-gloom-role="header-help-action"
            data-gloom-interactive="true"
            role="button"
            tabIndex={0}
            aria-label="Open Help"
            aria-keyshortcuts="?"
            onMouseDown={openHelp}
            onKeyDown={(event: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }) => {
              if (event.key === "Enter" || event.key === " ") openHelp(event);
            }}
            hoverBackgroundColor={blendHex(colors.header, colors.headerText, 0.15)}
            style={{
              border: `1px solid ${blendHex(colors.border, colors.headerText, 0.28)}`,
              borderRadius: 5,
              paddingInline: 7,
              marginRight: 8,
              backgroundColor: blendHex(colors.header, colors.headerText, 0.08),
              cursor: "pointer",
            }}
          >
            <Text fg={colors.headerText} style={{ fontSize: 11, fontWeight: 700 }}>Help</Text>
            <Text fg={blendHex(colors.headerText, colors.header, 0.38)} style={{ marginLeft: 6, fontSize: 10 }}>?</Text>
          </Box>
        ) : null}
        {mktLabel ? (
          <Box paddingRight={1}>
            <DesktopHeaderPill
              backgroundColor={blendHex(colors.header, mktColor, 0.12)}
              borderColor={blendHex(colors.border, mktColor, 0.3)}
            >
              <Text fg={mktColor} style={{ fontSize: 11, fontWeight: 700 }}>{mktLabel}</Text>
            </DesktopHeaderPill>
          </Box>
        ) : null}
        <Box paddingRight={1}>
          <Text fg={spyColor}>{spyText}</Text>
        </Box>
        <Box paddingRight={showWindowControls ? 1 : 0}>
          <Text fg={colors.headerText}>{baseCurrency}</Text>
        </Box>
        {showWindowControls ? <Box flexShrink={0} width={`${WINDOWS_CONTROL_GROUP_WIDTH_PX}px`} /> : null}
        {showWindowControls ? <WindowControls /> : null}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="row"
      height={1}
      backgroundColor={colors.header}
      data-gloom-role="app-header"
      data-titlebar-overlay={titleBarOverlay ? "true" : undefined}
      onMouseDown={startWindowDrag}
    >
      <Box paddingLeft={titleBarOverlay ? titlebarLeadingInset : 1}>
        <Text attributes={TextAttributes.BOLD} fg={colors.headerText}>
          Gloomberb v{VERSION}
        </Text>
      </Box>
      <Box flexGrow={1} paddingLeft={2}>
        <UpdateStatus />
      </Box>
      {mktLabel && (
        <Box paddingRight={1}>
          <Text fg={mktColor}>{mktLabel}</Text>
        </Box>
      )}
      <Box paddingRight={1}>
        <Text fg={spyColor}>{spyText}</Text>
      </Box>
      <Box paddingRight={1}>
        <Text fg={colors.headerText}>
          {baseCurrency}
        </Text>
      </Box>
      {showWindowControls ? <WindowControls /> : null}
    </Box>
  );
}
