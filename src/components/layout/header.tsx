import { Box, SpinnerMark, Text, TextAttributes, useRendererHost, useUiCapabilities, useUiHost } from "../../ui";
import { useCallback, useEffect } from "react";
import { blendHex, commandBarBg } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
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
import { detectShortcutPlatform, formatPrimaryShortcut, getShortcutDisplayMode } from "../../utils/shortcut-labels";
import { getTitlebarLeadingInset } from "./titlebar-overlay";
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

/**
 * An affordance, not an input: it opens the overlay and never takes keyboard
 * focus. Gloomberb's panes are driven by bare single keys, so a live header
 * input would swallow every pane shortcut.
 */
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
  const { placeholder, shortcut } = resolveHeaderPromptContent(width, shortcutLabel);
  const idleBg = blendHex(colors.header, colors.bg, 0.55);
  // The overlay opens across this row and renders the live query there, so the
  // prompt yields the row entirely rather than painting a second surface under
  // it.
  const backgroundColor = open ? undefined : idleBg;
  const caretColor = blendHex(colors.headerText, colors.header, 0.15);
  const mutedColor = blendHex(colors.headerText, colors.header, 0.42);

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
        ...(nativePaneChrome
          ? {
            border: `1px solid ${blendHex(colors.border, colors.headerText, 0.24)}`,
            borderRadius: 5,
          }
          : {}),
      }}
    >
      {open ? null : (
        <>
          <Text fg={caretColor} attributes={TextAttributes.BOLD}>{"> "}</Text>
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
  const titlebarLeadingInset = titleBarOverlay && nativeWindowChrome ? getTitlebarLeadingInset() : 0;
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
        <Box
          width={prompt.left}
          paddingLeft={titlebarLeadingInset + 1}
          flexDirection="row"
          alignItems="center"
        />
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
      <Box width={prompt.left} paddingLeft={1} flexDirection="row" />
      {commandPrompt}
      <Box flexGrow={1} minWidth={0} paddingLeft={2}>
        <UpdateStatus />
      </Box>
      {showWindowControls ? <WindowControls /> : null}
    </Box>
  );
}
