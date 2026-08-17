import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, type TextareaRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import type { TickerResearchTabProps } from "../../../types/plugin";
import { usePaneTicker } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { MarkdownEditor } from "../../../components/markdown-editor";
import { usePaneFooter } from "../../../components";
import type { NotesFiles } from "./files";
import { MarkdownNotePreview } from "./markdown-note-preview";
import { useSyncedText } from "./text-state";

export function createNotesTab(notesFiles: NotesFiles) {
  return function NotesTab({ focused, width, onCapture }: TickerResearchTabProps) {
    const { ticker } = usePaneTicker();
    const textareaRef = useRef<TextareaRenderable | null>(null);
    const [notesFocused, setNotesFocused] = useState(false);
    const { text: noteText, textRef: noteTextRef, setText: setNoteText } = useSyncedText("");
    const wasNotesFocusedRef = useRef(false);
    const loadedSymbolRef = useRef<string | null>(null);

    const setNotesFocusedAndCapture = useCallback((value: boolean) => {
      setNotesFocused(value);
      onCapture(value);
    }, [onCapture]);

    const getCurrentNoteText = useCallback(() => (
      textareaRef.current ? textareaRef.current.editBuffer.getText() : noteTextRef.current
    ), [noteTextRef]);

    const tickerSymbol = ticker?.metadata.ticker ?? null;

    const handleNoteChange = useCallback((value: string) => {
      if (tickerSymbol) {
        loadedSymbolRef.current = tickerSymbol;
      }
      setNoteText(value);
    }, [setNoteText, tickerSymbol]);

    const saveNotesFor = useCallback((symbol: string | null, text: string) => {
      if (!symbol) return;
      notesFiles.save(symbol, text).catch(() => {});
    }, [notesFiles]);

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

    const prevSymbolRef = useRef<string | null>(null);
    useEffect(() => {
      if (tickerSymbol !== prevSymbolRef.current) {
        if (prevSymbolRef.current) {
          saveNotesFor(prevSymbolRef.current, getCurrentNoteText());
        }
        prevSymbolRef.current = tickerSymbol;
        loadedSymbolRef.current = null;
        setNoteText("");
        textareaRef.current?.setText("");

        if (notesFocused) {
          setNotesFocusedAndCapture(false);
        }

        if (!tickerSymbol) {
          return;
        }

        let cancelled = false;
        notesFiles.load(tickerSymbol).then((nextNotes) => {
          if (cancelled || prevSymbolRef.current !== tickerSymbol) return;
          loadedSymbolRef.current = tickerSymbol;
          setNoteText(nextNotes);
          textareaRef.current?.setText(nextNotes);
        }).catch(() => {
          if (cancelled || prevSymbolRef.current !== tickerSymbol) return;
          loadedSymbolRef.current = tickerSymbol;
          setNoteText("");
          textareaRef.current?.setText("");
        });
        return () => {
          cancelled = true;
        };
      }
    }, [tickerSymbol, getCurrentNoteText, notesFocused, saveNotesFor, notesFiles, setNoteText, setNotesFocusedAndCapture]);

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
