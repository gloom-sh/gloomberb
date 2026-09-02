import {
  Box,
  Input,
  SpinnerMark,
  Text,
  TextAttributes,
  useRendererHost,
  useUiCapabilities,
  useUiHost,
  type InputRenderable,
} from "../../ui";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  blendHex,
  commandBarBg,
  commandBarPanelBg,
  commandBarSubtleText,
  commandBarText,
} from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { NATIVE_COMMAND_SURFACE, nativeCommandSurfaceBorder } from "../command-bar/panel/native-surface";
import {
  useCommandBarPromptBinding,
  type CommandBarPromptBinding,
} from "../command-bar/panel/prompt-binding";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import {
  selectCommandBarOpen,
  selectUpdateAvailable,
  selectUpdateCheckInProgress,
  selectUpdateNotice,
  selectUpdateProgress,
} from "../../state/selectors-ui";
import { useViewport } from "../../react/input";
import { t, tf } from "../../i18n";
import { truncateToDisplayWidth } from "../../utils/format";
import { detectShortcutPlatform, formatPrimaryShortcut, getShortcutDisplayMode } from "../../utils/shortcut-labels";
import { resolveMarketSummaryFit, useMarketSummary } from "./market-summary";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";

const UPDATE_NOTICE_DURATION_MS = 5_000;

type HeaderActionEvent = {
  key?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

/**
 * Chooses what the prompt can say at a given width. The descriptive label earns
 * its space before the shortcut hint does, because the prompt is what tells a
 * first-time user the command bar exists at all.
 */
function resolveHeaderPromptContent(width: number, shortcutLabel: string): {
  placeholder: string;
  shortcut: string;
} {
  const textSpace = Math.max(0, width - 2 - "> ".length);
  const full = t("Search or run a command");
  const short = t("Search");
  if (textSpace >= full.length + shortcutLabel.length + 2) return { placeholder: full, shortcut: shortcutLabel };
  if (textSpace >= full.length) return { placeholder: full, shortcut: "" };
  if (textSpace >= short.length) return { placeholder: short, shortcut: "" };
  return { placeholder: "", shortcut: "" };
}

const PROMPT_CARET = "> ";

/**
 * Desktop chrome for the prompt. Closed it is a self-contained pill. Open it is
 * the top half of the command surface: same fill, same border and same shadow
 * as the sheet, rounded only where it is not touching it, and stretched to the
 * header's full height so the two meet with no gap. Both boxes take their left
 * edge and width from `resolveHeaderPromptGeometry`, so the seam is invisible
 * rather than nearly invisible.
 */
function nativePromptSurfaceStyle(colors: ReturnType<typeof useThemeColors>, open: boolean) {
  if (!open) {
    return {
      border: `1px solid ${blendHex(colors.border, colors.headerText, 0.24)}`,
      borderRadius: 5,
    };
  }
  const { radiusPx, shadow } = NATIVE_COMMAND_SURFACE;
  return {
    alignSelf: "stretch",
    height: "100%",
    border: `1px solid ${nativeCommandSurfaceBorder(colors)}`,
    borderBottomWidth: 0,
    borderRadius: `${radiusPx}px ${radiusPx}px 0 0`,
    boxShadow: shadow,
  };
}

/**
 * The command bar's input while the bar is open. Gloomberb's panes are driven
 * by bare single keys, so the input only exists while the bar is open; the idle
 * prompt is an affordance that never takes keyboard focus.
 */
function HeaderPromptInput({
  binding,
  nativePaneChrome,
  width,
}: {
  binding: CommandBarPromptBinding;
  nativePaneChrome: boolean;
  width: number;
}) {
  const colors = useThemeColors();
  const inputRef = useRef<InputRenderable | null>(null);
  const { ghostSuffix, onQueryChange, placeholder, query, screenKey } = binding;
  const textColor = commandBarText(colors);
  const subtleColor = commandBarSubtleText(colors);

  // The buffer is the source of truth while typing; only an outside change,
  // such as Ctrl+U or a popped route restoring its query, has to be written back.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || input.editBuffer.getText() === query) return;
    input.editBuffer.setText?.(query);
    input.setCursorOffset?.(query.length);
  }, [query, screenKey]);

  const ghostLeft = Math.max(0, Math.min(query.length, width - 1));
  return (
    <Box width={width} height={1} position="relative" style={nativePaneChrome ? undefined : { overflow: "hidden" }}>
      <Input
        key={screenKey}
        ref={inputRef}
        value={query}
        onInput={onQueryChange}
        placeholder={placeholder}
        focused
        data-gloom-remote-scope="command-bar"
        data-gloom-remote-surface="command-bar"
        width={nativePaneChrome ? "100%" : width}
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        textColor={textColor}
        focusedTextColor={textColor}
        placeholderColor={subtleColor}
        cursorColor={colors.textBright}
      />
      {ghostSuffix && (
        <Box position="absolute" top={0} left={ghostLeft} width={Math.max(0, width - ghostLeft)} height={1}>
          <Text fg={subtleColor}>{truncateToDisplayWidth(ghostSuffix, Math.max(0, width - ghostLeft))}</Text>
        </Box>
      )}
    </Box>
  );
}

function HeaderCommandPrompt({
  nativePaneChrome,
  onOpen,
  open,
  shortcutLabel,
  width,
}: {
  nativePaneChrome: boolean;
  onOpen: (event?: HeaderActionEvent) => void;
  open: boolean;
  shortcutLabel: string;
  width: number;
}) {
  const colors = useThemeColors();
  const binding = useCommandBarPromptBinding();
  const { placeholder, shortcut } = resolveHeaderPromptContent(width, shortcutLabel);
  const idleBg = blendHex(colors.header, colors.bg, 0.55);
  // Open, the prompt takes the sheet's own surface so the two read as one
  // control: the sheet is the prompt, expanded.
  const backgroundColor = open
    ? (nativePaneChrome ? commandBarPanelBg(colors) : commandBarBg(colors))
    : idleBg;
  const caretColor = open
    ? commandBarText(colors)
    : blendHex(colors.headerText, colors.header, 0.15);
  const mutedColor = blendHex(colors.headerText, colors.header, 0.42);
  const inputWidth = Math.max(1, width - 2 - PROMPT_CARET.length);

  return (
    <Box
      width={width}
      height={1}
      flexDirection="row"
      alignItems="center"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={backgroundColor}
      hoverBackgroundColor={open ? undefined : blendHex(idleBg, colors.headerText, 0.16)}
      data-gloom-role="header-command-prompt"
      data-gloom-interactive={open ? undefined : "true"}
      role={open ? undefined : "button"}
      tabIndex={open ? undefined : 0}
      aria-label={t("Search or run a command")}
      aria-keyshortcuts={shortcutLabel}
      onMouseDown={open ? undefined : onOpen}
      onKeyDown={open ? undefined : (event: HeaderActionEvent) => {
        if (event.key === "Enter" || event.key === " ") onOpen(event);
      }}
      style={{
        cursor: open ? undefined : "pointer",
        ...(nativePaneChrome ? nativePromptSurfaceStyle(colors, open) : {}),
      }}
    >
      <Text fg={caretColor} attributes={TextAttributes.BOLD}>{PROMPT_CARET}</Text>
      {open ? (
        binding ? <HeaderPromptInput binding={binding} nativePaneChrome={nativePaneChrome} width={inputWidth} /> : null
      ) : (
        <>
          <Text fg={mutedColor}>{placeholder}</Text>
          <Box flexGrow={1} minWidth={0} />
          {shortcut ? <Text fg={mutedColor}>{shortcut}</Text> : null}
        </>
      )}
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

/**
 * Market state, SPY and the base currency at the header's right edge. It fits
 * itself into the columns the prompt geometry reserved rather than into
 * whatever this row has left over, so the cluster and the prompt can never
 * both claim the same space.
 */
function HeaderMarketSummary({ nativePaneChrome, width }: { nativePaneChrome: boolean; width: number }) {
  const colors = useThemeColors();
  const summary = useMarketSummary();
  const fit = resolveMarketSummaryFit({
    available: width,
    baseCurrencyWidth: summary.baseCurrency.length + 1,
    countdownWidth: summary.marketLabel.length - summary.marketLabelShort.length,
    spyWidth: summary.spyText.length + 1,
    stateWidth: summary.marketLabelShort ? summary.marketLabelShort.length + 1 : 0,
  });
  const marketLabel = fit.showCountdown ? summary.marketLabel : summary.marketLabelShort;

  return (
    <>
      {fit.showState && marketLabel ? (
        <Box paddingRight={1} flexShrink={0}>
          <Text fg={summary.marketColor} {...(nativePaneChrome ? { attributes: TextAttributes.BOLD } : {})}>
            {marketLabel}
          </Text>
        </Box>
      ) : null}
      {fit.showSpy ? (
        <Box paddingRight={1} flexShrink={0}>
          <Text fg={summary.spyColor}>{summary.spyText}</Text>
        </Box>
      ) : null}
      {fit.showBaseCurrency ? (
        <Box paddingRight={1} flexShrink={0}>
          <Text fg={blendHex(colors.headerText, colors.header, 0.42)}>{summary.baseCurrency}</Text>
        </Box>
      ) : null}
    </>
  );
}

export function Header({
  onOpenHelp,
}: {
  onOpenHelp?: () => void;
}) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const dispatch = useAppDispatch();
  const commandBarOpen = useAppSelector(selectCommandBarOpen);
  const { width: termWidth } = useViewport();
  const uiKind = useUiHost().kind;
  const { nativePaneChrome = false, titleBarOverlay, nativeWindowChrome = titleBarOverlay, windowControls } = useUiCapabilities();
  const showWindowControls = nativeWindowChrome && windowControls === "windows";
  const prompt = resolveHeaderPromptGeometry({
    nativePaneChrome,
    nativeWindowChrome,
    termWidth,
    titleBarOverlay,
  });
  // Ctrl+P is the terminal's canonical binding; desktop hosts get the platform
  // modifier with K, which the global shortcut accepts everywhere.
  const shortcutLabel = getShortcutDisplayMode(uiKind) === "terminal"
    ? "Ctrl+P"
    : formatPrimaryShortcut("K", detectShortcutPlatform(), "platform");

  const startWindowDrag = useCallback(() => {
    if (!titleBarOverlay || !nativeWindowChrome) return;
    void rendererHost.startWindowDrag?.();
  }, [nativeWindowChrome, rendererHost, titleBarOverlay]);

  const openCommandBar = useCallback((event?: HeaderActionEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
  }, [dispatch]);

  const openHelp = useCallback((event?: HeaderActionEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    onOpenHelp?.();
  }, [onOpenHelp]);

  const commandPrompt = (
    <HeaderCommandPrompt
      nativePaneChrome={nativePaneChrome}
      onOpen={openCommandBar}
      open={commandBarOpen}
      shortcutLabel={shortcutLabel}
      width={prompt.width}
    />
  );
  const marketSummary = prompt.marketColumns > 0
    ? <HeaderMarketSummary nativePaneChrome={nativePaneChrome} width={prompt.marketColumns} />
    : null;

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
          paddingRight: showWindowControls ? 0 : 12,
          position: "relative",
        }}
      >
        <Box width={prompt.left} />
        {commandPrompt}
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
        {marketSummary}
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
      <Box width={prompt.left} />
      {commandPrompt}
      <Box flexGrow={1} minWidth={0} paddingLeft={2}>
        <UpdateStatus />
      </Box>
      {marketSummary}
      {showWindowControls ? <WindowControls /> : null}
    </Box>
  );
}
