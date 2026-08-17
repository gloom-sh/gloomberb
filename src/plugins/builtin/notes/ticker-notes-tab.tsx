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

    const setNotesFocusedAndCapture = useCallback((value: boolean) => {
      setNotesFocused(value);
      onCapture(value);
    }, [onCapture]);

    const getCurrentNoteText = useCallback(() => (
      textareaRef.current?.editBuffer.getText() ?? noteTextRef.current
    ), [noteTextRef]);

    const saveNotesFor = useCallback((symbol: string | null, text: string) => {
      if (!symbol) return;
      notesFiles.save(symbol, text).catch(() => {});
    }, [notesFiles]);

    useEffect(() => {
      if (wasNotesFocusedRef.current && !notesFocused && ticker?.metadata.ticker) {
        saveNotesFor(ticker.metadata.ticker, getCurrentNoteText());
      }
      wasNotesFocusedRef.current = notesFocused;
    }, [getCurrentNoteText, notesFocused, ticker, saveNotesFor]);

    useEffect(() => {
      if (!focused && notesFocused) {
        setNotesFocusedAndCapture(false);
      }
    }, [focused, notesFocused, setNotesFocusedAndCapture]);

    const tickerSymbol = ticker?.metadata.ticker ?? null;
    const prevSymbolRef = useRef<string | null>(null);
    useEffect(() => {
      if (tickerSymbol !== prevSymbolRef.current) {
        if (textareaRef.current && prevSymbolRef.current) {
          saveNotesFor(prevSymbolRef.current, textareaRef.current.editBuffer.getText());
        }
        prevSymbolRef.current = tickerSymbol;

        if (!tickerSymbol) {
          setNoteText("");
          textareaRef.current?.setText("");
          return;
        }

        notesFiles.load(tickerSymbol).then((nextNotes) => {
          setNoteText(nextNotes);
          textareaRef.current?.setText(nextNotes);
        }).catch(() => {
          setNoteText("");
          textareaRef.current?.setText("");
        });
      }
    }, [tickerSymbol, saveNotesFor, notesFiles, setNoteText]);

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
              textareaKey={tickerSymbol ?? "none"}
              focused={focused}
              initialValue={noteText}
              placeholder="Write notes about this ticker..."
              onRef={(ref) => { textareaRef.current = ref; }}
              onChange={setNoteText}
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
