/**
 * The rebindable half of Help > Shortcuts.
 *
 * Every row is an action from the keybinding table or a command the user bound
 * to a chord. Enter (or a double click) captures the next keypress for the
 * selected row, which is the one thing a config file cannot do: show what the
 * terminal actually delivered for a combination before it is committed. The
 * actions live in the pane footer with every other pane's hints, and the
 * capture prompt is a footer status segment.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyActionBinding,
  coreActionOnChord,
  describeKeybindingIssue,
  formatChordForHost,
  isTypingChord,
  keyChordFromEvent,
  keyChordsOverlap,
  primaryModifierFor,
  removeCommandBinding,
  resolveKeybindings,
  serializeKeyChord,
  setCommandBinding,
  shortActionLabel,
  subscribeKeybindingCapture,
  takenChordMessage,
  takeKeybindingCaptureRequest,
  updateKeybindingsConfig,
  type KeyChord,
  type KeybindingCommand,
  type ResolvedKeybindingAction,
  type ResolvedKeybindings,
} from "../../../app/keybindings";
import {
  buildSectionedRows,
  DataTableView,
  EMPTY_TABLE_CELL,
  isSectionedItemRow,
  renderSectionedRowHeader,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type SectionedRow,
} from "../../../components";
import { t, tf } from "../../../i18n";
import { useShortcut } from "../../../react/input";
import { useAppDispatch, useAppSelector, useAppStateRef } from "../../../state/app/context";
import { saveConfigImmediately } from "../../../state/config-save-scheduler";
import { useThemeColors } from "../../../theme/theme-context";
import type { KeybindingsConfig } from "../../../types/config";
import type { KeyboardShortcut } from "../../../types/plugin";
import { useUiCapabilities, useUiHost } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { logFailure } from "../../../utils/log-failure";
import { detectShortcutPlatform, getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import { getSharedRegistry } from "../../registry";
import { usePluginAppActions } from "../../runtime";
import { badgeCell, badgeColumnWidth, helpRowLines, helpTextWidth, mutedCell, type HelpRowLine } from "./table-cells";

const CAPTURE_SCOPE = "help-keybinding-capture";
const FOOTER_ID = "help-keybindings";
const NOTE_COLUMN_WIDTH = 26;
/** What the table takes besides its columns: its side padding, the gaps between columns and the scrollbar. */
const TABLE_CHROME = 5;
/** ACTION keeps at least this beside NOTE; narrower, NOTE is dropped and the footer carries the selected row's. */
const ACTION_MIN_WIDTH = 30;

/**
 * Whether the NOTE column shows: only while some row has a note, and ACTION
 * keeps ACTION_MIN_WIDTH cells beside it. At 80 cells an empty NOTE took 26
 * while ACTION read "Change the focused pa…".
 */
function showsKeybindingNotes(width: number, keyColumnWidth: number, anyNote: boolean): boolean {
  return anyNote && width - TABLE_CHROME - keyColumnWidth - NOTE_COLUMN_WIDTH >= ACTION_MIN_WIDTH;
}

type KeybindingColumnId = "key" | "action" | "note";
type KeybindingColumn = DataTableColumn & { id: KeybindingColumnId };

interface BindableRow {
  id: string;
  kind: "action" | "command";
  /** Chords, already formatted for this host. */
  chords: string[];
  label: string;
  note: string;
  noteTone: "muted" | "warning";
  action?: ResolvedKeybindingAction;
  command?: KeybindingCommand;
  /** The terminal's line of the row this row draws (helpRowLines). */
  line?: HelpRowLine;
}

type EditorRow = SectionedRow<BindableRow>;

/** A row's first line, the one the cursor stops on. */
function isBindingRow(row: EditorRow): row is { kind: "item"; key: string; item: BindableRow } {
  return isSectionedItemRow(row) && !row.item.line?.continued;
}

type CaptureTarget =
  | { kind: "row"; row: BindableRow }
  | { kind: "new-command"; query: string };

interface Feedback {
  tone: "info" | "warning";
  text: string;
}

function pluginShortcutsFromRegistry(disabledPlugins: readonly string[]): KeyboardShortcut[] {
  const registry = getSharedRegistry();
  if (!registry?.shortcuts) return [];
  const disabled = new Set(disabledPlugins);
  return [...registry.shortcuts.values()].filter((shortcut) => {
    const pluginId = registry.getShortcutPluginId?.(shortcut.id);
    return !pluginId || !disabled.has(pluginId);
  });
}

function conflictNote(
  resolved: ResolvedKeybindings,
  target: string,
  describe: (id: string) => string,
): string | null {
  const others = resolved.issues
    .filter((issue): issue is Extract<typeof issue, { kind: "conflict" }> => (
      issue.kind === "conflict" && issue.targets.includes(target)
    ))
    .flatMap((issue) => issue.targets.filter((entry) => entry !== target));
  if (others.length === 0) return null;
  return tf("also {target}", { target: [...new Set(others)].map(describe).join(", ") });
}

export function KeybindingsEditor({
  focused,
  width,
  height,
}: {
  focused: boolean;
  width: number;
  height: number;
}) {
  const colors = useThemeColors();
  const uiHost = useUiHost();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const { openCommandBar, notify } = usePluginAppActions();
  const keybindingsConfig = useAppSelector((state) => state.config.keybindings);
  const disabledPlugins = useAppSelector((state) => state.config.disabledPlugins);
  const isDesktop = uiHost.kind === "desktop-web";
  const displayMode = getShortcutDisplayMode(uiHost.kind);
  const platform = detectShortcutPlatform();
  const primaryModifier = primaryModifierFor(displayMode, platform);
  const formatChord = useCallback(
    (chord: KeyChord) => formatChordForHost(chord, displayMode, platform),
    [displayMode, platform],
  );

  const pluginShortcuts = useMemo(() => pluginShortcutsFromRegistry(disabledPlugins), [disabledPlugins]);
  const resolved = useMemo(
    () => resolveKeybindings(keybindingsConfig, { pluginShortcuts, host: isDesktop ? "desktop" : "terminal" }),
    [isDesktop, keybindingsConfig, pluginShortcuts],
  );

  const describeTarget = useCallback((target: string): string => {
    if (target.startsWith("command:")) {
      const command = resolved.commands.find((entry) => `command:${entry.text}` === target);
      return `"${command?.query ?? target.slice("command:".length)}"`;
    }
    const action = resolved.actionsById.get(target);
    return shortActionLabel(action?.def ? t(action.def.description) : action?.pluginShortcut?.description ?? target);
  }, [resolved]);

  const rows = useMemo<EditorRow[]>(() => {
    const actionRow = (action: ResolvedKeybindingAction): BindableRow => {
      const conflict = conflictNote(resolved, action.id, describeTarget);
      return {
        id: `action:${action.id}`,
        kind: "action",
        chords: action.chords.map(formatChord),
        label: action.def ? t(action.def.description) : action.pluginShortcut?.description ?? action.id,
        note: conflict
          ?? (action.custom
            ? tf("custom, default {chord}", { chord: action.defaults.map(formatChord).join(", ") || t("none") })
            : ""),
        noteTone: conflict ? "warning" : "muted",
        action,
      };
    };
    const core = resolved.actions.filter((action) => action.def
      && (isDesktop ? !action.def.terminalOnly : !action.def.desktopOnly));
    const plugin = resolved.actions.filter((action) => action.pluginShortcut);
    const commandRows = resolved.commands.map((command): BindableRow => {
      const conflict = conflictNote(resolved, `command:${command.text}`, describeTarget);
      return {
        id: `command:${command.text}`,
        kind: "command",
        chords: [formatChord(command.chord)],
        label: command.query,
        note: conflict ?? "",
        noteTone: conflict ? "warning" : "muted",
        command,
      };
    });

    return buildSectionedRows<BindableRow>([
      { label: "Global Keys", items: core.filter((action) => action.def!.category === "Global Keys").map(actionRow) },
      { label: "Pane Management", items: core.filter((action) => action.def!.category === "Pane Management").map(actionRow) },
      {
        label: "Custom Commands",
        items: commandRows,
        emptyLabel: "No commands bound yet. Type one in the command bar and choose Bind a key.",
      },
      ...(plugin.length > 0 ? [{ label: "Plugin Shortcuts", items: plugin.map(actionRow) }] : []),
    ], (row) => row.id);
  }, [describeTarget, formatChord, isDesktop, resolved]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const bindableRows = useMemo(() => rows.filter(isSectionedItemRow).map((row) => row.item), [rows]);
  const selectedRow = bindableRows.find((row) => row.id === selectedId) ?? bindableRows[0];
  const effectiveSelectedId = selectedRow?.id ?? null;
  const [capture, setCapture] = useState<CaptureTarget | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const writeKeybindings = useCallback((next: KeybindingsConfig | undefined) => {
    dispatch({ type: "SET_KEYBINDINGS", keybindings: next });
    saveConfigImmediately(updateKeybindingsConfig(stateRef.current.config, next)).catch((error: unknown) => {
      logFailure("help.keybindings", "Saving keybindings failed")(error);
      notify({ type: "error", body: t("Could not save your keybindings.") });
    });
  }, [dispatch, notify, stateRef]);

  const startCapture = useCallback((target: CaptureTarget) => {
    setFeedback(null);
    setCapture(target);
    if (target.kind === "row") setSelectedId(target.row.id);
  }, []);

  // "Bind a key" from the command bar and the keybinding notice land here; the
  // pane may have been opened for them, so the request is read on mount as
  // well as on change.
  useEffect(() => {
    const consume = () => {
      const request = takeKeybindingCaptureRequest();
      if (request?.kind === "command") startCapture({ kind: "new-command", query: request.query });
      if (request?.kind === "review") {
        const flagged = bindableRows.find((row) => row.noteTone === "warning");
        if (flagged) setSelectedId(flagged.id);
      }
    };
    consume();
    return subscribeKeybindingCapture(consume);
  }, [bindableRows, startCapture]);

  const captureLabel = capture
    ? capture.kind === "row" ? shortActionLabel(capture.row.label) : `"${capture.query}"`
    : null;

  const commitChord = useCallback((chord: KeyChord) => {
    if (!capture) return;
    const config = stateRef.current.config.keybindings;
    const isCommand = capture.kind === "new-command" || capture.row.kind === "command";
    if (isCommand && isTypingChord(chord)) {
      setFeedback({ tone: "warning", text: t("That key would fire while typing. Use Ctrl, Cmd, Alt or a function key.") });
      return;
    }
    // A built-in action's key is refused, so a binding never leaves the command bar or close pane dead.
    const core = coreActionOnChord(resolved, chord, capture.kind === "row" ? capture.row.action?.id : undefined, { command: isCommand });
    if (core) {
      setFeedback({ tone: "warning", text: takenChordMessage(formatChord(chord), core) });
      return;
    }
    if (isCommand) {
      const query = capture.kind === "new-command" ? capture.query : capture.row.command!.query;
      let next = config;
      if (capture.kind === "row") next = removeCommandBinding(next, capture.row.command!.text);
      writeKeybindings(setCommandBinding(next, chord, query));
      setSelectedId(`command:${serializeKeyChord(chord)}`);
    } else {
      const action = capture.row.action!;
      writeKeybindings(applyActionBinding(config, action.id, [chord], action.defaults));
    }
    setCapture(null);
    const taken = resolved.actions.find((action) => (
      action.chords.some((existing) => keyChordsOverlap(existing, chord))
      && (capture.kind !== "row" || action.id !== capture.row.action?.id)
    ));
    // The row already shows which binding changed, so the footer stays short
    // enough to survive beside the hints.
    setFeedback(taken
      ? { tone: "warning", text: tf("Also bound to {target}.", { target: describeTarget(taken.id) }) }
      : { tone: "info", text: tf("Bound to {chord}.", { chord: formatChord(chord) }) });
  }, [capture, describeTarget, formatChord, resolved, stateRef, writeKeybindings]);

  // Capture owns the keyboard: a fresh scope in the earliest phase gets first
  // refusal over every app shortcut, and preventDefault keeps the desktop
  // webview from acting on chords like Cmd+W itself.
  useShortcut((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.name === "escape") {
      setCapture(null);
      setFeedback(null);
      return;
    }
    const chord = keyChordFromEvent(event, primaryModifier);
    if (chord) commitChord(chord);
  }, { enabled: capture !== null, scope: CAPTURE_SCOPE, phase: "before", allowEditable: true });

  const unbindSelected = useCallback(() => {
    if (!selectedRow) return;
    const config = stateRef.current.config.keybindings;
    if (selectedRow.kind === "command") {
      writeKeybindings(removeCommandBinding(config, selectedRow.command!.text));
      setFeedback({ tone: "info", text: t("Key removed.") });
      return;
    }
    const action = selectedRow.action!;
    writeKeybindings(applyActionBinding(config, action.id, [], action.defaults));
    setFeedback({ tone: "info", text: t("Unbound.") });
  }, [selectedRow, stateRef, writeKeybindings]);

  const canReset = selectedRow?.kind === "action" && selectedRow.action?.custom === true;
  const resetSelected = useCallback(() => {
    if (!selectedRow || selectedRow.kind !== "action" || !selectedRow.action?.custom) return;
    const action = selectedRow.action;
    writeKeybindings(applyActionBinding(stateRef.current.config.keybindings, action.id, action.defaults, action.defaults));
    setFeedback({
      tone: "info",
      text: tf("Back on {chord}.", { chord: action.defaults.map(formatChord).join(", ") || t("nothing") }),
    });
  }, [formatChord, selectedRow, stateRef, writeKeybindings]);

  const bindNewCommand = useCallback(() => {
    notify({ body: t("Type a command, then choose Bind a key.") });
    openCommandBar("");
  }, [notify, openCommandBar]);

  // While capturing, a refused key explains itself in place of the prompt.
  // Otherwise the footer carries the selected row's note in full, since the
  // note column truncates, and falls back to whatever the config got wrong.
  const status: Feedback | null = capture
    ? feedback?.tone === "warning"
      ? feedback
      : {
        tone: "info",
        // The row being rebound shows its own prompt, so only a new command
        // has to name what the key will run.
        text: capture.kind === "row"
          ? t("Press a key. Esc cancels.")
          : tf("Press a key for {target}. Esc cancels.", { target: captureLabel ?? "" }),
      }
    : feedback
      ?? (selectedRow?.note
        ? { tone: selectedRow.noteTone === "warning" ? "warning" : "info", text: selectedRow.note }
        : null)
      ?? (resolved.issues[0] ? { tone: "warning", text: describeKeybindingIssue(resolved.issues[0]) } : null);

  usePaneFooter(FOOTER_ID, () => ({
    info: status
      ? [{ id: "status", parts: [{ text: status.text, tone: status.tone === "warning" ? "warning" as const : "muted" as const }] }]
      : [],
    hints: capture
      ? [{ id: "cancel", key: "Esc", label: "cancel", onPress: () => setCapture(null) }]
      : [
        { id: "rebind", key: "Enter", label: "rebind", onPress: () => selectedRow && startCapture({ kind: "row", row: selectedRow }), disabled: !selectedRow },
        // Not Backspace: that is the back key, and unbinding takes no confirmation.
        { id: "unbind", key: "x", label: "unbind", title: "Unbind", onPress: unbindSelected, disabled: !selectedRow },
        { id: "default", key: "0", label: "default", onPress: resetSelected, disabled: !canReset },
        { id: "bind-command", key: "n", label: "ew command key", onPress: bindNewCommand },
      ],
  }), [bindNewCommand, canReset, capture, resetSelected, selectedRow, startCapture, status, unbindSelected]);

  const handleRootKey = useCallback((event: DataTableKeyEvent): boolean | void => {
    if (capture) return;
    if (isPlainKey(event, "x", "delete")) {
      unbindSelected();
    } else if (isPlainKey(event, "0")) {
      resetSelected();
    } else if (isPlainKey(event, "n")) {
      bindNewCommand();
    } else {
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }, [bindNewCommand, capture, resetSelected, unbindSelected]);

  const keyColumnWidth = useMemo(
    () => badgeColumnWidth([...bindableRows.map((row) => row.chords), [t("Press a key")]]),
    [bindableRows],
  );
  // Decided from every row, not the rows on screen, so ACTION's width holds while the table scrolls.
  const anyNote = useMemo(() => bindableRows.some((row) => !!row.note), [bindableRows]);
  const showNotes = showsKeybindingNotes(width, keyColumnWidth, anyNote);
  const { nativePaneChrome } = useUiCapabilities();
  // The terminal goes on under a row rather than cutting its keys or what they do; the desktop lays it out in CSS.
  const displayRows = useMemo<EditorRow[]>(() => {
    if (nativePaneChrome) return rows;
    const actionWidth = helpTextWidth(width, keyColumnWidth + (showNotes ? NOTE_COLUMN_WIDTH + 1 : 0), 1);
    return rows.flatMap((row): EditorRow[] => (isSectionedItemRow(row) && row.item.chords.length > 0
      ? helpRowLines(row.item.chords, row.item.label, keyColumnWidth, actionWidth).map((line, index) => ({
        kind: "item",
        key: index === 0 ? row.key : `${row.key}~${index}`,
        item: { ...row.item, line },
      }))
      : [row]));
  }, [keyColumnWidth, nativePaneChrome, rows, showNotes, width]);
  const columns = useMemo<KeybindingColumn[]>(() => [
    { id: "key", label: "KEY", width: keyColumnWidth, align: "left" },
    { id: "action", label: "ACTION", width: 20, align: "left", flexGrow: 1 },
    ...(showNotes
      ? [{ id: "note" as const, label: "NOTE", width: NOTE_COLUMN_WIDTH, align: "left" as const }]
      : []),
  ], [keyColumnWidth, showNotes]);

  const renderCell = useCallback((
    row: EditorRow,
    column: KeybindingColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    if (row.kind === "section") return EMPTY_TABLE_CELL;
    if (row.kind === "empty") {
      return column.id === "action" ? { text: t(row.label), color: colors.textDim } : EMPTY_TABLE_CELL;
    }
    const { line } = row.item;
    const capturing = capture?.kind === "row" && capture.row.id === row.item.id;
    const selected = rowState.selected || (line?.continued === true && row.item.id === effectiveSelectedId);
    if (column.id === "key") {
      if (capturing) return line?.continued ? EMPTY_TABLE_CELL : badgeCell([t("Press a key")], column.width, { tone: "accent" });
      if (line) return line.badges.length > 0 ? badgeCell(line.badges, column.width) : EMPTY_TABLE_CELL;
      return row.item.chords.length > 0
        ? badgeCell(row.item.chords, column.width)
        : mutedCell("unbound", colors.textMuted);
    }
    if (column.id === "action") {
      return { text: line ? line.text : row.item.label, color: selected ? colors.selectedText : colors.text };
    }
    if (line?.continued) return EMPTY_TABLE_CELL;
    return {
      text: row.item.note,
      color: row.item.noteTone === "warning" ? colors.warning : colors.textMuted,
    };
  }, [capture, colors, effectiveSelectedId]);

  return (
    <DataTableView<EditorRow, KeybindingColumn>
      focused={focused && !capture}
      keyboardNavigation={!capture}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={displayRows}
      selection={{
        kind: "id",
        selectedId: effectiveSelectedId,
        getId: (row) => row.key,
        onChange: (_id, row) => {
          if (isSectionedItemRow(row)) setSelectedId(row.item.id);
        },
      }}
      isNavigable={isBindingRow}
      // Pressing a row's later line selects the row, as pressing its first does.
      continuesRowAbove={(row) => isSectionedItemRow(row) && row.item.line?.continued === true}
      // A row's lines under its first read as one row with it.
      getRowBackgroundColor={(row) => (isSectionedItemRow(row) && row.item.line?.continued && row.item.id === effectiveSelectedId ? colors.selected : undefined)}
      onActivate={(row) => {
        if (isSectionedItemRow(row)) startCapture({ kind: "row", row: row.item });
      }}
      onRootKeyDown={handleRootKey}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={(row) => row.key}
      renderSectionHeader={renderSectionedRowHeader}
      renderCell={renderCell}
      emptyStateTitle="No keybindings"
    />
  );
}
