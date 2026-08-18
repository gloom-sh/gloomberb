import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, type TextareaRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import type { TickerResearchTabProps } from "../../../types/plugin";
import { usePaneTicker } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { MarkdownEditor } from "../../../components/markdown-editor";
import { usePaneFooter } from "../../../components";
import { usePluginAppActions } from "../../runtime";
import type { NotesFiles } from "./files";
import { MarkdownNotePreview } from "./markdown-note-preview";
import { useSyncedText } from "./text-state";

export function createNotesTab(notesFiles: NotesFiles) {
  return function NotesTab({ focused, width, onCapture }: TickerResearchTabProps) {
    const { ticker } = usePaneTicker();
    const { notify } = usePluginAppActions();
    const textareaRef = useRef<TextareaRenderable | null>(null);
    const [notesFocused, setNotesFocused] = useState(false);
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
      if (!symbol) return;
      // Blur and symbol switches both save; without this every ticker switch
      // rewrites an unchanged file and can clobber another pane on the same symbol.
      if (lastSavedTextRef.current.get(symbol) === text) return;
      lastSavedTextRef.current.set(symbol, text);
      notesFiles.save(symbol, text).catch((error) => {
        console.error("[notes] Failed to save ticker note:", error);
        notify({ body: "Failed to save note. Check disk space and permissions.", type: "error" });
      });
    }, [notesFiles, notify]);

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
      applyNoteText("");

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
      notesFiles.load(tickerSymbol).then(applyLoaded, () => applyLoaded(""));

      return () => {
        cancelled = true;
        if (loadedSymbolRef.current === tickerSymbol) {
          saveNotesFor(tickerSymbol, getCurrentNoteText());
        }
      };
    }, [tickerSymbol, applyNoteText, getCurrentNoteText, saveNotesFor, notesFiles]);

    useShortcut((event) => {
      if (!focused) return;
      const isEnter = event.name === "enter" || event.name === "return";
      if (isEnter && !notesFocused) {
        setNotesFocusedAndCapture(true);
        return;
      }
      if (event.name === "escape" && notesFocused) {
        setNotesFocusedAndCapture(false);
        return;
      }
    }, { allowEditable: true });

    usePaneFooter("ticker-notes", () => ({
      info: [
        { id: "mode", parts: [{ text: notesFocused ? "editing" : "viewing", tone: "muted" }] },
      ],
    }), [notesFocused]);

    if (!ticker) return <Text fg={colors.textDim}>Select a ticker to view notes.</Text>;

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box flexGrow={1} minHeight={0} paddingX={1} onMouseDown={() => { if (!notesFocused) setNotesFocusedAndCapture(true); }}>
          {notesFocused ? (
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
              onActivate={() => setNotesFocusedAndCapture(true)}
            />
          )}
        </Box>
      </Box>
    );
  };
}
