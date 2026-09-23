import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type TextareaRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import type { TickerResearchTabProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import { MarkdownEditor } from "../../../components/markdown-editor";
import { EmptyState, usePaneFooter } from "../../../components";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { useDialog } from "../../../ui/dialog";
import { MarkdownNotePreview } from "./markdown-note-preview";
import {
  defaultNoteOwner,
  NoteOwnerStrip,
  ReadOnlyBanner,
  resolveNoteConflict,
  useNoteTeams,
} from "./owner";
import { NoteConflictError, type NoteOwner, type NotesStoreRegistry } from "./store";
import { useSyncedText } from "./text-state";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";

export function createNotesTab(registry: NotesStoreRegistry) {
  return function NotesTab({ focused, width, onCapture }: TickerResearchTabProps) {
    const { ticker } = usePaneTickerIdentity();
    const { notify } = usePluginAppActions();
    const dialog = useDialog();
    const teams = useNoteTeams();
    // The fallback is read once, so it keeps one identity for the whole life
    // of the tab the way the lazy initial state it replaces did.
    const initialOwner = useMemo(defaultNoteOwner, []);
    const [owner, setOwner] = usePluginPaneState<NoteOwner>("noteOwner", initialOwner);
    // A team the account left falls back to personal notes.
    const effectiveOwner = owner.kind === "team" && !teams.some((team) => team.id === owner.teamId)
      ? { kind: "user" as const }
      : owner;
    const notesFiles = useMemo(() => registry.forOwner(effectiveOwner), [effectiveOwner.kind, effectiveOwner.kind === "team" ? effectiveOwner.teamId : ""]);
    const ownerKey = `${effectiveOwner.kind}:${effectiveOwner.kind === "team" ? effectiveOwner.teamId : ""}`;
    const textareaRef = useRef<TextareaRenderable | null>(null);
    const [notesFocused, setNotesFocused] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const { text: noteText, textRef: noteTextRef, setText: setNoteText } = useSyncedText("");
    const wasNotesFocusedRef = useRef(false);
    const notesFocusedRef = useRef(notesFocused);
    notesFocusedRef.current = notesFocused;
    const loadedSymbolRef = useRef<string | null>(null);
    const lastSavedTextRef = useRef<Map<string, string>>(new Map());

    const setNotesFocusedAndCapture = useCallback((value: boolean) => {
      setNotesFocused(value);
      onCapture(value);
    }, [onCapture]);
    const setNotesFocusedAndCaptureRef = useRef(setNotesFocusedAndCapture);
    setNotesFocusedAndCaptureRef.current = setNotesFocusedAndCapture;

    const applyNoteText = useCallback((text: string) => {
      setNoteText(text);
      textareaRef.current?.setText(text);
    }, [setNoteText]);

    const getCurrentNoteText = useCallback(() => {
      try {
        return textareaRef.current?.editBuffer.getText() ?? noteTextRef.current;
      } catch {
        return noteTextRef.current;
      }
    }, [noteTextRef]);

    const tickerSymbol = ticker?.metadata.ticker ?? null;

    const handleNoteChange = useCallback((value: string) => {
      if (tickerSymbol && value !== noteTextRef.current) {
        loadedSymbolRef.current = tickerSymbol;
      }
      setNoteText(value);
    }, [noteTextRef, setNoteText, tickerSymbol]);

    const saveNotesFor = useCallback((symbol: string | null, text: string) => {
      if (!symbol || notesFiles.readOnly) return;
      // Blur and symbol switches both save; without this every ticker switch
      // rewrites an unchanged file and can clobber another pane on the same symbol.
      if (lastSavedTextRef.current.get(symbol) === text) return;
      lastSavedTextRef.current.set(symbol, text);
      notesFiles.save(symbol, text).catch(async (error: unknown) => {
        if (error instanceof NoteConflictError) {
          // Keep the buffer; the person chooses between the two versions.
          lastSavedTextRef.current.delete(symbol);
          const choice = await resolveNoteConflict(dialog, error);
          const cloud = registry.cloud(effectiveOwner);
          if (choice === "reload") {
            const theirs = error.current?.content ?? "";
            if (cloud && error.current) cloud.acceptCurrent(symbol, error.current);
            lastSavedTextRef.current.set(symbol, theirs);
            if (loadedSymbolRef.current === symbol) applyNoteText(theirs);
          } else if (choice === "overwrite") {
            if (cloud && error.current) cloud.acceptCurrent(symbol, error.current);
            lastSavedTextRef.current.set(symbol, text);
            await notesFiles.save(symbol, text).catch((again: unknown) => {
              notify({ body: again instanceof Error ? again.message : "Could not save the note.", type: "error" });
            });
          }
          return;
        }
        console.error("[notes] Failed to save ticker note:", error);
        notify({ body: error instanceof Error ? error.message : "Failed to save note.", type: "error" });
      });
    }, [applyNoteText, dialog, effectiveOwner, notesFiles, notify]);

    useEffect(() => {
      if (
        wasNotesFocusedRef.current
        && !notesFocused
        && tickerSymbol
        && loadedSymbolRef.current === tickerSymbol
      ) {
        saveNotesFor(tickerSymbol, getCurrentNoteText());
      }
      wasNotesFocusedRef.current = notesFocused;
    }, [getCurrentNoteText, notesFocused, tickerSymbol, saveNotesFor]);

    useEffect(() => {
      if (!focused && notesFocused) {
        setNotesFocusedAndCapture(false);
      }
    }, [focused, notesFocused, setNotesFocusedAndCapture]);

    useEffect(() => {
      loadedSymbolRef.current = null;
      lastSavedTextRef.current.clear();
      applyNoteText("");
      setLoadError(null);

      if (notesFocusedRef.current) {
        setNotesFocusedAndCaptureRef.current(false);
      }

      if (!tickerSymbol) return;

      let cancelled = false;
      const applyLoaded = (text: string) => {
        if (cancelled || loadedSymbolRef.current === tickerSymbol) return;
        loadedSymbolRef.current = tickerSymbol;
        lastSavedTextRef.current.set(tickerSymbol, text);
        applyNoteText(text);
      };
      notesFiles.load(tickerSymbol).then(applyLoaded, (error: unknown) => {
        // Leave the symbol unloaded so the unmount save below cannot overwrite it.
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });

      return () => {
        cancelled = true;
        if (loadedSymbolRef.current === tickerSymbol) {
          saveNotesFor(tickerSymbol, getCurrentNoteText());
        }
      };
    }, [tickerSymbol, applyNoteText, getCurrentNoteText, saveNotesFor, notesFiles, ownerKey]);

    useShortcut((event) => {
      if (!focused || loadError || !tickerSymbol) return;
      if (isPlainKey(event, "enter", "return") && !notesFocused && !notesFiles.readOnly) {
        event.preventDefault();
        setNotesFocusedAndCapture(true);
        return;
      }
      if (isPlainKey(event, "escape") && notesFocused) {
        event.preventDefault();
        setNotesFocusedAndCapture(false);
      }
    }, { allowEditable: true });

    usePaneFooter("ticker-notes", () => ({
      info: loadError
        ? [{ id: "load-error", parts: [{ text: loadError, tone: "warning" as const }] }]
        : [{ id: "mode", parts: [{ text: notesFiles.readOnly ? "read-only" : notesFocused ? "editing" : "viewing", tone: "muted" as const }] }],
    }), [loadError, notesFiles.readOnly, notesFocused]);

    if (!ticker) return <Text fg={colors.textDim}>Select a ticker to view notes.</Text>;

    return (
      <Box flexDirection="column" flexGrow={1}>
        <NoteOwnerStrip
          owner={effectiveOwner}
          teams={teams}
          width={width}
          onSelect={(next) => {
            if (tickerSymbol && loadedSymbolRef.current === tickerSymbol) saveNotesFor(tickerSymbol, getCurrentNoteText());
            setOwner(next);
          }}
        />
        {notesFiles.readOnly && <ReadOnlyBanner owner={effectiveOwner} teams={teams} />}
        <Box flexGrow={1} minHeight={0} paddingX={1} onMouseDown={() => { if (!notesFocused && !loadError && !notesFiles.readOnly) setNotesFocusedAndCapture(true); }}>
          {loadError ? (
            <EmptyState
              title="These notes could not be read."
              message={loadError}
              hint="Editing is disabled so the saved note is not overwritten."
            />
          ) : notesFocused ? (
            <MarkdownEditor
              textareaKey="editing"
              focused={focused}
              initialValue={noteText}
              placeholder="Write notes about this ticker..."
              onRef={(ref) => { textareaRef.current = ref; }}
              onChange={handleNoteChange}
            />
          ) : (
            <MarkdownNotePreview
              text={noteText}
              width={width}
              placeholder="Write notes about this ticker..."
              onActivate={() => { if (!loadError && !notesFiles.readOnly) setNotesFocusedAndCapture(true); }}
            />
          )}
        </Box>
      </Box>
    );
  };
}
