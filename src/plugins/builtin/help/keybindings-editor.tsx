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
  subscribeKeybindingCapture,
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
import { useUiHost } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { detectShortcutPlatform, getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import { getSharedRegistry } from "../../registry";
import { usePluginAppActions } from "../../runtime";
import { badgeCell, badgeColumnWidth, mutedCell } from "./table-cells";

const CAPTURE_SCOPE = "help-keybinding-capture";
const FOOTER_ID = "help-keybindings";
const NOTE_COLUMN_WIDTH = 26;
/** Below this the note column is dropped; the footer still carries the detail. */
const NOTE_COLUMN_MIN_TABLE_WIDTH = 76;

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
}

type EditorRow = SectionedRow<BindableRow>;

type CaptureTarget =
  | { kind: "row"; row: BindableRow }
  | { kind: "new-command"; query: string };

interface Feedback {
  tone: "info" | "warning";
  text: string;
}

/** The first clause of a description, for messages that name an action mid-sentence. */
function shortLabel(description: string): string {
  const clause = description.split(/[,.](?:\s|$)/)[0] ?? description;
  return clause.trim() || description.trim();
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
    return shortLabel(action?.def ? t(action.def.description) : action?.pluginShortcut?.description ?? target);
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
    void saveConfigImmediately(updateKeybindingsConfig(stateRef.current.config, next));
  }, [dispatch, stateRef]);

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
    ? capture.kind === "row" ? shortLabel(capture.row.label) : `"${capture.query}"`
    : null;

  const commitChord = useCallback((chord: KeyChord) => {
    if (!capture) return;
    const config = stateRef.current.config.keybindings;
    if (capture.kind === "new-command" || capture.row.kind === "command") {
      if (isTypingChord(chord)) {
        setFeedback({ tone: "warning", text: t("That key would fire while typing. Use Ctrl, Cmd, Alt or a function key.") });
        return;
      }
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
  }, [capture, captureLabel, describeTarget, formatChord, resolved.actions, stateRef, writeKeybindings]);

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
  const columns = useMemo<KeybindingColumn[]>(() => [
    { id: "key", label: "KEY", width: keyColumnWidth, align: "left" },
    { id: "action", label: "ACTION", width: 20, align: "left", flexGrow: 1 },
    ...(width >= NOTE_COLUMN_MIN_TABLE_WIDTH
      ? [{ id: "note" as const, label: "NOTE", width: NOTE_COLUMN_WIDTH, align: "left" as const }]
      : []),
  ], [keyColumnWidth, width]);

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
    const capturing = capture?.kind === "row" && capture.row.id === row.item.id;
    if (column.id === "key") {
      if (capturing) return badgeCell([t("Press a key")], column.width, { tone: "accent" });
      return row.item.chords.length > 0
        ? badgeCell(row.item.chords, column.width)
        : mutedCell("unbound", colors.textMuted);
    }
    if (column.id === "action") {
      return { text: row.item.label, color: rowState.selected ? colors.selectedText : colors.text };
    }
    return {
      text: row.item.note,
      color: row.item.noteTone === "warning" ? colors.warning : colors.textMuted,
    };
  }, [capture, colors]);

  return (
    <DataTableView<EditorRow, KeybindingColumn>
      focused={focused && !capture}
      keyboardNavigation={!capture}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={rows}
      selection={{
        kind: "id",
        selectedId: effectiveSelectedId,
        getId: (row) => row.key,
        onChange: (_id, row) => {
          if (isSectionedItemRow(row)) setSelectedId(row.item.id);
        },
      }}
      isNavigable={isSectionedItemRow}
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
