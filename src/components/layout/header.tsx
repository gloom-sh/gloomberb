import {
  Box,
  Input,
  SpinnerMark,
  Text,
  TextAttributes,
  useActionShortcut,
  useCommandBarShortcut,
  useRendererHost,
  useUiCapabilities,
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
import { useViewport } from "../../react/input";
import { canRetryUpdate } from "../../app/global-shortcuts";
import { t, tf } from "../../i18n";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { ClippedText } from "../ui/display";
import { resolveMarketSummaryFit, useMarketSummary } from "./market-summary";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
import { useWindowFullscreen } from "./window-fullscreen";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";
import { Button, terminalButtonColumns } from "../ui/button";

const UPDATE_NOTICE_DURATION_MS = 5_000;
/**
 * The failed-update message is cut to the room it has, but not below this many
 * columns ("Update fa..."): narrower says nothing, so the banner is left out.
 * The retry hint gives way before the message goes under it.
 */
const UPDATE_ERROR_MIN_COLUMNS = 12;
/** Kept clear after the failed-update banner, so its last character never touches the Help pill. */
const UPDATE_ERROR_GAP_COLUMNS = 1;
/** Left padding of the update status's slot, in cells; the desktop's title-bar layout also pads its right. */
const UPDATE_SLOT_PADDING_COLUMNS = 2;
/** The Help pill's own props, shared by its button and the width the update status leaves it. */
const helpButtonProps = () => ({ label: "Open Help", displayLabel: t("Help"), shortcut: "?", compact: true });
/** The terminal pads the pill's right edge by a cell; the desktop pads it in px. */
const TERMINAL_HELP_PADDING_COLUMNS = 1;

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
/** Room for a pasted list of a few thousand symbols. */
const COMMAND_BAR_MAX_LENGTH = 20_000;

/**
 * The topbar's own fill in the terminal. The prompt used to be the only thing
 * wearing it, which left the bar reading as a pale input pasted onto a darker
 * strip; now the whole row carries it and the prompt paints nothing of its own.
 * Desktop has real chrome to sit on and uses the header colour directly.
 */
function headerSurface(colors: ReturnType<typeof useThemeColors>): string {
  return blendHex(colors.header, colors.bg, 0.55);
}

/**
 * Desktop chrome for the prompt. Closed it draws nothing: no fill and no edge,
 * so the caret and its placeholder sit straight on the header instead of in a
 * pale box pasted onto it. The hover fill is the whole affordance, and the
 * border stays in the box model as a transparent hairline so opening the bar
 * cannot shift the text by a pixel. Open it is the top half of the command
 * surface: same fill, same border and same shadow as the sheet, rounded only
 * where it is not touching it, and stretched to the header's full height so the
 * two meet with no gap. Both boxes take their left edge and width from
 * `resolveHeaderPromptGeometry`, so the seam is invisible rather than nearly
 * invisible.
 */
function nativePromptSurfaceStyle(colors: ReturnType<typeof useThemeColors>, open: boolean) {
  if (!open) {
    return {
      border: "1px solid transparent",
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
        // A pasted list of symbols is one line of them, and may run past the field's stock thousand characters.
        joinPastedLines
        maxLength={COMMAND_BAR_MAX_LENGTH}
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
      {ghostSuffix && (nativePaneChrome ? (
        // The desktop sets the suggestion right after the typed text, one
        // character per `ch` of the field's font, and cuts it where the field ends.
        <Box position="absolute" top={0} height={1} flexDirection="row" style={{ left: `${displayWidth(query)}ch`, right: 0 }}>
          <ClippedText fg={subtleColor} text={ghostSuffix} width={0} />
        </Box>
      ) : (
        <Box position="absolute" top={0} left={ghostLeft} width={Math.max(0, width - ghostLeft)} height={1}>
          <Text fg={subtleColor}>{truncateToDisplayWidth(ghostSuffix, Math.max(0, width - ghostLeft))}</Text>
        </Box>
      ))}
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
  const idleBg = headerSurface(colors);
  // Open, the prompt takes the sheet's own surface so the two read as one
  // control: the sheet is the prompt, expanded. Closed it fills nothing on
  // either host; the terminal row is already this colour end to end, and on
  // desktop the header is.
  const backgroundColor = open
    ? (nativePaneChrome ? commandBarPanelBg(colors) : commandBarBg(colors))
    : undefined;
  const caretColor = open
    ? commandBarText(colors)
    : blendHex(colors.headerText, colors.header, 0.15);
  const mutedColor = blendHex(colors.headerText, colors.header, 0.42);
  // Dimmer than the placeholder it trails: the label is what names the control,
  // the binding is a footnote to it.
  const shortcutColor = blendHex(colors.headerText, colors.header, 0.62);
  // Desktop hover lifts the prompt off the header itself, which is the only
  // thing telling the pointer this text is a control. The terminal has no
  // chrome, so it lifts off the strip fill the whole row already wears.
  const hoverBg = nativePaneChrome
    ? blendHex(colors.header, colors.headerText, 0.14)
    : blendHex(idleBg, colors.headerText, 0.16);
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
      hoverBackgroundColor={open ? undefined : hoverBg}
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
          {shortcut ? <Text fg={shortcutColor}>{`  ${shortcut}`}</Text> : null}
          <Box flexGrow={1} minWidth={0} />
        </>
      )}
    </Box>
  );
}

/**
 * What the header says about an update. In the terminal it is cut to `columns`,
 * the room its slot is guaranteed (the desktop clips it in CSS where the slot
 * ends), so it never runs into the Help pill or the market cluster beside it.
 */
function UpdateStatus({ columns, onRestart }: { columns: number; onRestart?: () => void }) {
  const colors = useThemeColors();
  const { nativePaneChrome = false } = useUiCapabilities();
  const dispatch = useAppDispatch();
  const updateAvailable = useAppSelector((state) => state.updateAvailable);
  const updateProgress = useAppSelector((state) => state.updateProgress);
  const updateCheckInProgress = useAppSelector((state) => state.updateCheckInProgress);
  const updateNotice = useAppSelector((state) => state.updateNotice);
  // One key: Restart for a downloaded update, retry for a failed one.
  const updateKey = useActionShortcut("install-update");

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
    if (updateProgress.phase === "ready") {
      // A desktop update waits for the user: the app never relaunches by itself.
      // The terminal binary is already swapped in and only needs a new launch.
      if (updateProgress.canRestart && onRestart) {
        return (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text fg={colors.headerText}>{t("Update ready")}</Text>
            <Button compact label="Restart" shortcut={updateKey || undefined} onPress={onRestart} stopPropagation />
          </Box>
        );
      }
      return <Text fg={colors.headerText}>{t("Update ready, restart to apply")}</Text>;
    }
    if (updateProgress.phase === "done") {
      return <Text fg={colors.headerText}>{t(updateProgress.message ?? "Update ready, restart to apply")}</Text>;
    }
    if (updateProgress.phase === "error") {
      // One line: an error that carries a stack or a command's output must not grow the header.
      const message = tf("Update failed: {error}", { error: (updateProgress.error ?? "Unknown error").replace(/\s+/g, " ").trim() });
      const retry = updateKey && canRetryUpdate({ updateAvailable, updateProgress, updateCheckInProgress });
      const hint = retry ? `  ${updateKey} ${t("retry")}` : "";
      const hintColumns = displayWidth(hint);
      // The message goes first, and keeps its room before the hint takes any.
      const room = columns - UPDATE_ERROR_GAP_COLUMNS;
      const showHint = hintColumns > 0 && (nativePaneChrome || room - hintColumns >= UPDATE_ERROR_MIN_COLUMNS);
      const messageColumns = room - (showHint ? hintColumns : 0);
      if (!nativePaneChrome && messageColumns < UPDATE_ERROR_MIN_COLUMNS) return null;
      return (
        <Box flexDirection="row" overflow="hidden" paddingRight={UPDATE_ERROR_GAP_COLUMNS}>
          <ClippedText fg={colors.headerText} text={message} width={messageColumns} />
          {showHint ? <Text fg={blendHex(colors.headerText, colors.header, 0.62)}>{hint}</Text> : null}
        </Box>
      );
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
    if (updateAvailable.updateAction.kind === "managed") {
      return (
        <Text fg={colors.headerText}>
          {tf("v{version} available, update through the package manager that installed Gloomberb", {
            version: updateAvailable.version,
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

/**
 * Help, one click away on every renderer: the same pane the typed HELP and the
 * `?` key open. It takes its columns from the update status beside it, which
 * is transient, rather than from the prompt or the market cluster.
 */
function HeaderHelpButton({ nativePaneChrome, onPress }: { nativePaneChrome: boolean; onPress: () => void }) {
  return (
    <Box
      flexShrink={0}
      paddingRight={nativePaneChrome ? undefined : TERMINAL_HELP_PADDING_COLUMNS}
      data-gloom-role="header-help-action"
      style={nativePaneChrome ? { marginRight: 8 } : undefined}
    >
      <Button {...helpButtonProps()} onPress={onPress} stopPropagation />
    </Box>
  );
}

export function Header({
  onOpenHelp,
  onRestartForUpdate,
}: {
  onOpenHelp?: () => void;
  /** Applies a downloaded desktop update and relaunches; the header offers Restart only when it is given. */
  onRestartForUpdate?: () => void;
}) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const dispatch = useAppDispatch();
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const { width: termWidth } = useViewport();
  const { nativePaneChrome = false, titleBarOverlay, nativeWindowChrome = titleBarOverlay, windowControls } = useUiCapabilities();
  const showWindowControls = nativeWindowChrome && windowControls === "windows";
  const windowFullscreen = useWindowFullscreen();
  const prompt = resolveHeaderPromptGeometry({
    nativePaneChrome,
    nativeWindowChrome,
    termWidth,
    titleBarOverlay,
    windowFullscreen,
  });
  const shortcutLabel = useCommandBarShortcut();
  // The terminal lays the header out by cell counts, so it works out what is left
  // for the update status once the Help pill and the slot's padding are paid for.
  const updateStatusColumns = Math.max(
    0,
    prompt.updateColumns
      - (onOpenHelp ? terminalButtonColumns(helpButtonProps()) + TERMINAL_HELP_PADDING_COLUMNS : 0)
      - UPDATE_SLOT_PADDING_COLUMNS * (titleBarOverlay ? 2 : 1),
  );
  // Desktop has its own window chrome to sit on; the terminal has none, so the
  // bar itself wears the prompt's fill and reads as a single strip.
  const headerBg = nativePaneChrome ? colors.header : headerSurface(colors);

  const startWindowDrag = useCallback(() => {
    if (!titleBarOverlay || !nativeWindowChrome) return;
    void rendererHost.startWindowDrag?.();
  }, [nativeWindowChrome, rendererHost, titleBarOverlay]);

  const openCommandBar = useCallback((event?: HeaderActionEvent) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    dispatch({ type: "SET_COMMAND_BAR", open: true, query: "" });
  }, [dispatch]);

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
        backgroundColor={headerBg}
        data-gloom-role="app-header"
        data-titlebar-overlay="true"
        onMouseDown={startWindowDrag}
        style={{
          boxShadow: `0 -1px 0 ${headerBg}, inset 0 1px 0 ${headerBg}`,
          paddingRight: showWindowControls ? 0 : 12,
          position: "relative",
        }}
      >
        <Box width={prompt.left} />
        {commandPrompt}
        <Box flexGrow={1} paddingLeft={UPDATE_SLOT_PADDING_COLUMNS} paddingRight={UPDATE_SLOT_PADDING_COLUMNS} minWidth={0}>
          <UpdateStatus columns={updateStatusColumns} onRestart={onRestartForUpdate} />
        </Box>
        {onOpenHelp ? <HeaderHelpButton nativePaneChrome onPress={onOpenHelp} /> : null}
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
      backgroundColor={headerBg}
      data-gloom-role="app-header"
      data-titlebar-overlay={titleBarOverlay ? "true" : undefined}
      onMouseDown={startWindowDrag}
    >
      <Box width={prompt.left} />
      {commandPrompt}
      <Box flexGrow={1} minWidth={0} paddingLeft={UPDATE_SLOT_PADDING_COLUMNS}>
        <UpdateStatus columns={updateStatusColumns} onRestart={onRestartForUpdate} />
      </Box>
      {onOpenHelp ? <HeaderHelpButton nativePaneChrome={nativePaneChrome} onPress={onOpenHelp} /> : null}
      {marketSummary}
      {showWindowControls ? <WindowControls /> : null}
    </Box>
  );
}
