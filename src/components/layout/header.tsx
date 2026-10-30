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
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
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
import { useAppDispatch, useAppSelector, type AppState } from "../../state/app/context";
import { useViewport } from "../../react/input";
import { canRetryUpdate } from "../../updater";
import { updateFailureReason } from "../../updater/failure";
import { t, tf } from "../../i18n";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { ClippedText, NATIVE_CLIP_STYLE } from "../ui/display";
import { resolveMarketSummaryFit, useMarketSummary } from "./market-summary";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
import { useWindowFullscreen } from "./window-fullscreen";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";
import { Button, terminalButtonColumns } from "../ui/button";
import { DelayedMark, delayedMarkWidth } from "../ui/delayed-mark";

const UPDATE_NOTICE_DURATION_MS = 5_000;
/** Kept clear after the terminal update status, so its last character never touches the Help pill. */
const UPDATE_STATUS_GAP_COLUMNS = 1;
/** A clipped terminal notice narrower than this is left out rather than shown as a stub. */
const UPDATE_TEXT_MIN_COLUMNS = 8;
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
      borderRadius: "var(--gloom-radius-md)",
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
 * How fast the closed desktop prompt takes the bar's spare room next to the
 * update slot, which grows by one millionth as much: only empty space, if any.
 */
const NATIVE_PROMPT_GROW = 1_000_000;
/** How much faster the desktop update slot shrinks than an open prompt: it gives all of its room first. */
const NATIVE_UPDATE_SLOT_SHRINK = 1_000_000;
/**
 * How the desktop prompt sits in the bar. Closed it draws no box, so it claims
 * only its caret and placeholder, then grows toward `width` (the command
 * sheet's) from the room the update status leaves, showing its key hint once it
 * has room for it; Help and the market cluster never give any. Open it is the
 * top of the sheet and keeps the sheet's width: the update status gives all of
 * its room first (NATIVE_UPDATE_SLOT_SHRINK), and only a window too narrow for
 * Help and the market cluster beside the open prompt takes from it.
 */
function nativePromptFit(width: number, open: boolean) {
  return open
    ? { width, flexShrink: 1, minWidth: 0, overflow: "hidden" as const }
    : { flexBasis: 0, flexGrow: NATIVE_PROMPT_GROW, flexShrink: 0, minWidth: "min-content", maxWidth: width };
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
  // The desktop takes the theme's text roles; the terminal mixes from the header's own colours.
  const caretColor = open
    ? commandBarText(colors)
    : nativePaneChrome ? colors.text : blendHex(colors.headerText, colors.header, 0.15);
  const mutedColor = nativePaneChrome ? colors.textDim : blendHex(colors.headerText, colors.header, 0.42);
  // Dimmer than the placeholder it trails: the label is what names the control,
  // the binding is a footnote to it.
  const shortcutColor = nativePaneChrome ? colors.textMuted : blendHex(colors.headerText, colors.header, 0.62);
  // Desktop hover lifts the prompt off the header itself, which is the only
  // thing telling the pointer this text is a control. The terminal has no
  // chrome, so it lifts off the strip fill the whole row already wears.
  const hoverBg = nativePaneChrome
    ? "var(--gloom-hover-fill)"
    : blendHex(idleBg, colors.headerText, 0.16);
  const inputWidth = Math.max(1, width - 2 - PROMPT_CARET.length);

  return (
    <Box
      {...(nativePaneChrome ? nativePromptFit(width, open) : { width })}
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
      ) : nativePaneChrome ? (
        // One line that wraps and hides its second: the key hint drops whole when the
        // prompt is too narrow for it, and the placeholder never does.
        <Box
          flexDirection="row"
          height={1}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          overflow="hidden"
          style={{ flexWrap: "wrap", alignContent: "flex-start" }}
        >
          <Text fg={mutedColor}>{placeholder}</Text>
          {shortcut ? <Text fg={shortcutColor}>{`  ${shortcut}`}</Text> : null}
        </Box>
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
 * What the header says about an update, before either renderer lays it out:
 * a spinner and a line while something runs, a line on its own, the
 * downloaded update with its Restart button, or a failed update with the key
 * that retries it.
 */
type UpdateStatusView =
  | { kind: "busy"; text: string; parts: StatusPart[] }
  | { kind: "text"; text: string; compact?: string; clip?: boolean }
  | { kind: "restart"; text: string; version: string }
  | { kind: "failed"; message: string; parts: StatusPart[]; retry: boolean };

/** The failed banner's words without the reason, for a terminal slot too narrow to read one. */
const UPDATE_FAILED_SHORT = "Update failed";

/**
 * A line of the status in the pieces the desktop may treat apart: a `cut`
 * piece ends in an ellipsis and gives way, the rest stays whole. The download
 * keeps its percent and the failure the words that say so, while the version
 * and the error give way.
 */
interface StatusPart { text: string; cut: boolean }

/** Stands in for one value while a line is formatted, to find where that value sits in it. */
const SPLIT_MARK = "\u0000";

/** `marked`, formatted with SPLIT_MARK for `value`, as the pieces around the value: one whole line when it does not show. */
function partsAround(marked: string, value: string, valueIsCut: boolean): StatusPart[] {
  const [before, after, ...rest] = marked.split(SPLIT_MARK);
  if (after === undefined || rest.length > 0) return [{ text: marked.replaceAll(SPLIT_MARK, value), cut: true }];
  const parts = valueIsCut
    ? [{ text: before!, cut: false }, { text: `${value}${after}`, cut: true }]
    : [{ text: before!, cut: true }, { text: `${value}${after}`, cut: false }];
  return parts.filter((part) => part.text.length > 0);
}

function resolveUpdateStatusView({
  canRestart,
  updateAvailable,
  updateCheckInProgress,
  updateNotice,
  updateProgress,
}: Pick<AppState, "updateAvailable" | "updateProgress" | "updateCheckInProgress" | "updateNotice"> & {
  /** A Restart button can apply a downloaded update here. */
  canRestart: boolean;
}): UpdateStatusView | null {
  if (updateProgress) {
    if (updateProgress.phase === "downloading") {
      const version = updateAvailable?.version ?? "";
      const percent = String(updateProgress.percent ?? 0);
      return {
        kind: "busy",
        text: tf("Downloading v{version}: {percent}%", { version, percent }),
        parts: partsAround(tf("Downloading v{version}: {percent}%", { version, percent: SPLIT_MARK }), percent, false),
      };
    }
    if (updateProgress.phase === "replacing") {
      const text = t("Installing update...");
      return { kind: "busy", text, parts: [{ text, cut: true }] };
    }
    if (updateProgress.phase === "ready") {
      // A desktop update waits for the user: the app never relaunches by itself.
      // The terminal binary is already swapped in and only needs a new launch.
      if (updateProgress.canRestart && canRestart) {
        return { kind: "restart", text: t("Update ready"), version: updateAvailable?.version ?? "" };
      }
      return { kind: "text", text: t("Update ready, restart to apply"), compact: t("Update ready") };
    }
    if (updateProgress.phase === "done") {
      return { kind: "text", text: t(updateProgress.message ?? "Update ready, restart to apply") };
    }
    if (updateProgress.phase === "error") {
      // The reason in a few words; the whole error is in the command bar's Check
      // for Updates and the log. An error without one (from an older desktop
      // process) is shown on one line: a stack or a command's output must not
      // grow the header.
      const error = updateProgress.failure
        ? t(updateFailureReason(updateProgress.failure))
        : (updateProgress.error ?? "Unknown error").replace(/\s+/g, " ").trim();
      return {
        kind: "failed",
        message: tf("Update failed: {error}", { error }),
        parts: partsAround(tf("Update failed: {error}", { error: SPLIT_MARK }), error, true),
        retry: canRetryUpdate({ updateAvailable, updateProgress, updateCheckInProgress }),
      };
    }
  }
  if (updateCheckInProgress) {
    const text = t("Checking for updates...");
    return { kind: "busy", text, parts: [{ text, cut: true }] };
  }
  if (updateAvailable) {
    if (updateAvailable.updateAction.kind === "manual") {
      return {
        kind: "text",
        text: tf("v{version} available — run {command}", {
          version: updateAvailable.version,
          command: updateAvailable.updateAction.command,
        }),
      };
    }
    if (updateAvailable.updateAction.kind === "managed") {
      return {
        kind: "text",
        text: tf("v{version} available, update through the package manager that installed Gloom", {
          version: updateAvailable.version,
        }),
      };
    }
    return { kind: "text", text: tf("v{version} available — starting download...", { version: updateAvailable.version }) };
  }
  if (updateNotice) return { kind: "text", text: updateNotice, clip: true };
  return null;
}

/**
 * What the header says about an update, and the key that acts on it (Restart
 * for a downloaded update, retry for a failed one). A passing notice goes
 * after its time.
 */
function useUpdateStatus(canRestart: boolean): { view: UpdateStatusView | null; updateKey: string } {
  const dispatch = useAppDispatch();
  const updateAvailable = useAppSelector((state) => state.updateAvailable);
  const updateProgress = useAppSelector((state) => state.updateProgress);
  const updateCheckInProgress = useAppSelector((state) => state.updateCheckInProgress);
  const updateNotice = useAppSelector((state) => state.updateNotice);
  const updateKey = useActionShortcut("install-update");

  useEffect(() => {
    if (!updateNotice || updateAvailable || updateProgress || updateCheckInProgress) return;
    const timeout = setTimeout(() => {
      dispatch({ type: "SET_UPDATE_NOTICE", notice: null });
    }, UPDATE_NOTICE_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [dispatch, updateAvailable, updateCheckInProgress, updateNotice, updateProgress]);

  const view = resolveUpdateStatusView({
    canRestart,
    updateAvailable,
    updateCheckInProgress,
    updateNotice,
    updateProgress,
  });
  return { view, updateKey };
}

/** The retry key after a failed update's message, when there is something to retry. */
function retryHint(view: Extract<UpdateStatusView, { kind: "failed" }>, updateKey: string): string {
  return updateKey && view.retry ? `  ${updateKey} ${t("retry")}` : "";
}

/**
 * Columns the terminal status takes when everything fits: the header gives
 * the slot that much from the closed prompt's empty room before dropping parts.
 */
function terminalUpdateStatusColumns(view: UpdateStatusView, updateKey: string): number {
  return UPDATE_STATUS_GAP_COLUMNS + terminalUpdateStatusContentColumns(view, updateKey);
}

function terminalUpdateStatusContentColumns(view: UpdateStatusView, updateKey: string): number {
  switch (view.kind) {
    case "busy":
      return 2 + displayWidth(view.text);
    case "restart":
      return displayWidth(view.text) + 1 + terminalButtonColumns({ label: "Restart", shortcut: updateKey || undefined, compact: true });
    case "failed":
      return displayWidth(view.message) + displayWidth(retryHint(view, updateKey));
    case "text":
      return displayWidth(view.text);
  }
}

/**
 * The narrowest the closed terminal prompt goes to make room for an update's
 * status: its caret and the whole placeholder, which sells the command bar to
 * a first-time user, without the key hint (resolveHeaderPromptContent).
 */
function terminalClosedPromptFloor(): number {
  return 2 + PROMPT_CARET.length + t("Search or run a command").length;
}

/**
 * What the header says about an update. The terminal fits it to `columns`,
 * the room its slot is guaranteed; the desktop and the web let the browser fit
 * it to the room the bar leaves (NativeUpdateStatus). Either way it never runs
 * into the Help pill or the market cluster beside it.
 */
function UpdateStatus({ columns, onRestart, status, trailingGap = false }: {
  columns: number;
  onRestart?: () => void;
  status: { view: UpdateStatusView | null; updateKey: string };
  /** The desktop title bar keeps a gap after the status as well as before it. */
  trailingGap?: boolean;
}) {
  const { nativePaneChrome = false } = useUiCapabilities();
  const { view, updateKey } = status;
  if (!view) return null;
  return nativePaneChrome
    ? <NativeUpdateStatus view={view} onRestart={onRestart} trailingGap={trailingGap} updateKey={updateKey} />
    : <TerminalUpdateStatus view={view} columns={columns} onRestart={onRestart} updateKey={updateKey} />;
}

function TerminalUpdateStatus({ columns, onRestart, updateKey, view }: {
  columns: number;
  onRestart?: () => void;
  updateKey: string;
  view: UpdateStatusView;
}) {
  const content = terminalUpdateStatusContent({ room: columns - UPDATE_STATUS_GAP_COLUMNS, onRestart, updateKey, view });
  if (!content) return null;
  return (
    <Box flexDirection="row" overflow="hidden" paddingRight={UPDATE_STATUS_GAP_COLUMNS}>
      {content}
    </Box>
  );
}

/** Whole status parts in priority order; only transient notices may be clipped. */
function terminalUpdateStatusContent({ onRestart, room, updateKey, view }: {
  onRestart?: () => void;
  room: number;
  updateKey: string;
  view: UpdateStatusView;
}): ReactNode {
  if (view.kind === "busy") {
    // The percent stays when the words give way; the spinner never stands alone.
    const text = fitStatusParts(view.parts, room - 2);
    return text ? <TerminalBusyStatus text={text} /> : null;
  }
  if (view.kind === "restart") {
    // The button stays when the words do not fit beside it.
    const buttonColumns = terminalButtonColumns({ label: "Restart", shortcut: updateKey || undefined, compact: true });
    if (room < buttonColumns) return null;
    const showText = displayWidth(view.text) + 1 + buttonColumns <= room;
    return <TerminalRestartStatus text={showText ? view.text : null} onRestart={onRestart} updateKey={updateKey} />;
  }
  if (view.kind === "failed") {
    const hint = retryHint(view, updateKey);
    const hintColumns = displayWidth(hint);
    const messageColumns = displayWidth(view.message);
    const short = t(UPDATE_FAILED_SHORT);
    // The reason and retry hint give way whole, leaving a compact failure signal.
    let text: string;
    let showHint = false;
    if (messageColumns + hintColumns <= room) {
      text = view.message;
      showHint = hintColumns > 0;
    } else if (messageColumns <= room) {
      text = view.message;
    } else if (displayWidth(short) + hintColumns <= room) {
      text = short;
      showHint = hintColumns > 0;
    } else if (displayWidth(short) <= room) {
      text = short;
    } else {
      return null;
    }
    return <TerminalFailedStatus text={text} hint={showHint ? hint : ""} />;
  }
  if (view.clip) {
    if (room < UPDATE_TEXT_MIN_COLUMNS) return null;
    return <TerminalTextStatus text={view.text} width={room} />;
  }
  const text = displayWidth(view.text) <= room ? view.text : view.compact;
  return text && displayWidth(text) <= room ? <TerminalTextStatus text={text} width={room} /> : null;
}

/**
 * A status line in `width` columns: the parts the desktop may clip instead
 * drop out whole in the terminal, keeping the download's percent readable.
 */
function fitStatusParts(parts: StatusPart[], width: number): string {
  const full = parts.map((part) => part.text).join("");
  if (displayWidth(full) <= width) return full;
  const compact = parts.filter((part) => !part.cut).map((part) => part.text).join("").trim();
  return displayWidth(compact) <= width ? compact : "";
}

function TerminalBusyStatus({ text }: { text: string }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" gap={1}>
      <SpinnerMark name="dots" color={colors.headerText} />
      <Text fg={colors.headerText}>{text}</Text>
    </Box>
  );
}

function TerminalRestartStatus({ onRestart, text, updateKey }: { onRestart?: () => void; text: string | null; updateKey: string }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" gap={1} alignItems="center">
      {text ? <Text fg={colors.headerText}>{text}</Text> : null}
      <Button compact label="Restart" shortcut={updateKey || undefined} onPress={onRestart} stopPropagation />
    </Box>
  );
}

function TerminalFailedStatus({ hint, text }: { hint: string; text: string }) {
  const colors = useThemeColors();
  return (
    <>
      <Text fg={colors.headerText}>{text}</Text>
      {hint ? <Text fg={blendHex(colors.headerText, colors.header, 0.62)}>{hint}</Text> : null}
    </>
  );
}

function TerminalTextStatus({ text, width }: { text: string; width: number }) {
  const colors = useThemeColors();
  return <ClippedText fg={colors.headerText} text={text} width={width} />;
}

/**
 * Text in the desktop status that gives way: it ends in an ellipsis as its room
 * shrinks, and goes rather than leave a stub. Alone on its line it goes below
 * about this many characters; beside a piece that stays whole it takes what
 * that piece leaves, down to NATIVE_STATUS_PIECE_MIN_CH.
 */
const NATIVE_STATUS_TEXT_MIN_CH = 8;
const NATIVE_STATUS_PIECE_MIN_CH = 3;
function nativeCutTextStyle(alone: boolean) {
  return {
    ...NATIVE_CLIP_STYLE,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: `${alone ? NATIVE_STATUS_TEXT_MIN_CH : NATIVE_STATUS_PIECE_MIN_CH}ch`,
    maxWidth: "max-content",
  } as const;
}
/**
 * A failed update's reason on the desktop: whole when the line has room for it,
 * so the retry key after it moves to the hidden line first; never wider than
 * what the words before it leave, so when even that is too little it stays on
 * the line and ends in an ellipsis instead of leaving with the key.
 */
function nativeReasonStyle(leadColumns: number) {
  return {
    ...NATIVE_CLIP_STYLE,
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: `${NATIVE_STATUS_PIECE_MIN_CH}ch`,
    maxWidth: `calc(100% - ${leadColumns}ch)`,
  } as const;
}

/** One cell between the parts of the desktop status, as `gap={1}` puts it in the terminal. */
const NATIVE_STATUS_GAP = "var(--cell-w)";

/**
 * The desktop and web update status, fitted by the browser to whatever room
 * the bar leaves it, never by counting cells. Its parts are given most
 * important first, and the row is one line tall and wraps: a part that does
 * not fit whole moves to a second line the row hides, and so does every part
 * after it, so a button is never cut, a spinner never spins on its own, and
 * nothing runs under Help. Text that may be cut gives way before anything
 * moves, ending in an ellipsis (nativeCutTextStyle). `reverse` lays the parts
 * out right to left, for a status whose most important part is on its right:
 * Restart stays when "Update ready" goes.
 */
function NativeStatusRow({ children, reverse = false, trailingGap }: {
  children: ReactNode;
  reverse?: boolean;
  trailingGap: boolean;
}) {
  return (
    <Box
      height={1}
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      overflow="hidden"
      paddingLeft={UPDATE_SLOT_PADDING_COLUMNS}
      paddingRight={trailingGap ? UPDATE_SLOT_PADDING_COLUMNS : 0}
      style={{
        flexDirection: reverse ? "row-reverse" : "row",
        flexWrap: "wrap",
        alignContent: "flex-start",
        alignItems: "center",
        justifyContent: reverse ? "flex-end" : "flex-start",
      }}
    >
      {/* Takes no room and always holds the first line, so even the most important part can leave it. */}
      <Box width={0} height={1} />
      {children}
    </Box>
  );
}

/** One piece of a status line, with the whole line as its tooltip in case it is cut. */
function nativeStatusPiece(part: StatusPart, index: number, { alone, color, title }: { alone: boolean; color: string; title: string }) {
  return part.cut
    ? <Text key={index} fg={color} title={title} style={nativeCutTextStyle(alone)}>{part.text}</Text>
    : <Text key={index} fg={color} title={title}>{part.text}</Text>;
}

function NativeUpdateStatus({ onRestart, trailingGap, updateKey, view }: {
  onRestart?: () => void;
  trailingGap: boolean;
  updateKey: string;
  view: UpdateStatusView;
}) {
  const colors = useThemeColors();
  const color = colors.headerText;
  if (view.kind === "busy") {
    // Right to left: the percent, then the words, then the spinner, which never shows without them.
    const alone = view.parts.every((part) => part.cut);
    return (
      <NativeStatusRow reverse trailingGap={trailingGap}>
        {view.parts.map((part, index) => nativeStatusPiece(part, index, { alone, color, title: view.text })).reverse()}
        <Box flexShrink={0} style={{ marginRight: NATIVE_STATUS_GAP }}>
          <SpinnerMark name="dots" color={color} />
        </Box>
      </NativeStatusRow>
    );
  }
  if (view.kind === "restart") {
    // Right to left: the button, then the words, which go whole before it does.
    return (
      <NativeStatusRow reverse trailingGap={trailingGap}>
        <Button
          compact
          label="Restart"
          shortcut={updateKey || undefined}
          title={view.version ? tf("Restart to apply v{version}", { version: view.version }) : undefined}
          onPress={onRestart}
          stopPropagation
        />
        <Text fg={color} style={{ marginRight: NATIVE_STATUS_GAP }}>{view.text}</Text>
      </NativeStatusRow>
    );
  }
  if (view.kind === "failed") {
    // The words that say it failed, then the reason, then the retry key, which
    // gives way first, as in the terminal: the reason is cut only once the key
    // is gone and it still does not fit (nativeReasonStyle).
    const hint = retryHint(view, updateKey);
    const lead = view.parts.reduce((total, part) => total + (part.cut ? 0 : displayWidth(part.text)), 0);
    return (
      <NativeStatusRow trailingGap={trailingGap}>
        {view.parts.map((part, index) => part.cut
          ? <Text key={index} fg={color} title={view.message} style={nativeReasonStyle(lead)}>{part.text}</Text>
          : nativeStatusPiece(part, index, { alone: false, color, title: view.message }))}
        {hint ? <Text fg={colors.textMuted}>{hint}</Text> : null}
      </NativeStatusRow>
    );
  }
  return (
    <NativeStatusRow trailingGap={trailingGap}>
      {nativeStatusPiece({ text: view.text, cut: true }, 0, { alone: true, color, title: view.text })}
    </NativeStatusRow>
  );
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
    baseCurrencyWidth: displayWidth(summary.baseCurrencyLabel) + 1,
    countdownWidth: summary.marketLabel.length - summary.marketLabelShort.length,
    // A delayed SPY keeps its mark: the two fit, or give way, together.
    spyWidth: summary.spyText.length + 1 + (summary.spyDelayMinutes != null ? delayedMarkWidth(summary.spyDelayMinutes, nativePaneChrome) + 1 : 0),
    stateWidth: summary.marketLabelShort ? summary.marketLabelShort.length + 1 : 0,
  });
  const marketLabel = fit.showCountdown ? summary.marketLabel : summary.marketLabelShort;

  return (
    <>
      {fit.showState && marketLabel ? (
        <Box paddingRight={1} flexShrink={0} data-gloom-role="header-market">
          <Text fg={summary.marketColor} {...(nativePaneChrome ? { attributes: TextAttributes.BOLD } : {})}>
            {marketLabel}
          </Text>
        </Box>
      ) : null}
      {fit.showSpy ? (
        <Box paddingRight={1} flexShrink={0} flexDirection="row" alignItems="center" gap={1} data-gloom-role="header-market">
          <Text fg={summary.spyColor}>{summary.spyText}</Text>
          {summary.spyDelayMinutes != null ? <DelayedMark minutes={summary.spyDelayMinutes} /> : null}
        </Box>
      ) : null}
      {fit.showBaseCurrency ? (
        <Box paddingRight={1} flexShrink={0}>
          <Text fg={nativePaneChrome ? colors.textDim : blendHex(colors.headerText, colors.header, 0.42)}>{summary.baseCurrencyLabel}</Text>
        </Box>
      ) : null}
    </>
  );
}

/**
 * Help, one click away on every renderer: the same pane the typed HELP and the
 * `?` key open. It takes its columns from the update status beside it, which
 * is transient, rather than from the market cluster; on the desktop and the
 * web the closed prompt's empty room makes way for it as well.
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
  const updateStatus = useUpdateStatus(!!onRestartForUpdate);
  const prompt = resolveHeaderPromptGeometry({
    nativePaneChrome,
    nativeWindowChrome,
    termWidth,
    titleBarOverlay,
    windowFullscreen,
    allowMarketExpansion: !updateStatus.view,
  });
  const shortcutLabel = useCommandBarShortcut();
  // The terminal lays the header out by cell counts, so it works out what is left
  // for the update status once the Help pill and the slot's padding are paid for.
  let updateStatusColumns = Math.max(
    0,
    prompt.updateColumns
      - (onOpenHelp ? terminalButtonColumns(helpButtonProps()) + TERMINAL_HELP_PADDING_COLUMNS : 0)
      - UPDATE_SLOT_PADDING_COLUMNS * (titleBarOverlay ? 2 : 1),
  );
  // Short of that, the closed prompt gives the status its empty room, down to
  // its placeholder, as the desktop's does: at 80 to 160 columns the slot alone
  // is too narrow to say anything. Open, the prompt is the command bar's input
  // and keeps its width.
  // The prompt's own right padding then stands for one of the slot's.
  let promptWidth = prompt.width;
  let terminalSlotPadding = UPDATE_SLOT_PADDING_COLUMNS;
  if (!nativePaneChrome && !commandBarOpen && updateStatus.view) {
    const need = terminalUpdateStatusColumns(updateStatus.view, updateStatus.updateKey);
    if (need > updateStatusColumns) {
      const spare = Math.max(0, prompt.width - terminalClosedPromptFloor());
      const given = Math.min(need - updateStatusColumns - 1, spare);
      promptWidth -= Math.max(0, given);
      terminalSlotPadding -= 1;
      updateStatusColumns += 1 + Math.max(0, given);
    }
  }
  // Desktop has its own window chrome to sit on; the terminal has none, so the
  // bar itself wears the prompt's fill and reads as a single strip.
  const headerBg = nativePaneChrome ? colors.header : headerSurface(colors);

  const startWindowDrag = useCallback((press?: { detail?: number }) => {
    if (!titleBarOverlay || !nativeWindowChrome) return;
    void rendererHost.startWindowDrag?.(press);
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
      width={promptWidth}
    />
  );
  const marketSummary = prompt.marketColumns > 0
    ? <HeaderMarketSummary nativePaneChrome={nativePaneChrome} width={prompt.marketColumns} />
    : null;
  // The desktop and the web fit the update status in CSS (NativeUpdateStatus):
  // its slot takes the room the closed prompt leaves, clips at its own edge, and
  // gives all of it up before an open prompt gives any. Help, the market
  // cluster and the caption buttons keep their size.
  const nativeUpdateSlot = nativePaneChrome ? (
    <Box
      flexDirection="row"
      alignItems="center"
      flexGrow={1}
      flexShrink={NATIVE_UPDATE_SLOT_SHRINK}
      minWidth={0}
      overflow="hidden"
      data-gloom-role="header-update-status"
      style={{ alignSelf: "stretch" }}
    >
      <UpdateStatus columns={updateStatusColumns} onRestart={onRestartForUpdate} status={updateStatus} trailingGap={!!titleBarOverlay} />
    </Box>
  ) : null;

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
        {nativeUpdateSlot ?? (
          <Box flexGrow={1} paddingLeft={terminalSlotPadding} paddingRight={UPDATE_SLOT_PADDING_COLUMNS} minWidth={0}>
            <UpdateStatus columns={updateStatusColumns} onRestart={onRestartForUpdate} status={updateStatus} />
          </Box>
        )}
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
      {nativeUpdateSlot ?? (
        <Box flexGrow={1} minWidth={0} paddingLeft={terminalSlotPadding}>
          <UpdateStatus columns={updateStatusColumns} onRestart={onRestartForUpdate} status={updateStatus} />
        </Box>
      )}
      {onOpenHelp ? <HeaderHelpButton nativePaneChrome={nativePaneChrome} onPress={onOpenHelp} /> : null}
      {marketSummary}
      {showWindowControls ? <WindowControls /> : null}
    </Box>
  );
}
