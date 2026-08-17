import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Input, Text, type InputRenderable, type TextareaRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import { MarkdownEditor } from "../../../components/markdown-editor";
import { ConfirmDialog, Tabs, usePaneFooter } from "../../../components";
import { type PromptContext, useDialog } from "../../../ui/dialog";
import type { NotesFiles } from "./files";
import { MarkdownNotePreview } from "./markdown-note-preview";
import {
  formatDeleteNoteTitle,
  formatLastEdited,
  generateNoteId,
  type QuickNoteEntry,
} from "./model";
import { useSyncedText } from "./text-state";

export function createQuickNotesPane(notesFiles: NotesFiles) {
  return function QuickNotesPane({ focused, width }: PaneProps) {
    const dialog = useDialog();
    const textareaRef = useRef<TextareaRenderable | null>(null);
    const [editing, setEditing] = useState(false);
    const [tabs, setTabs] = useState<QuickNoteEntry[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const { text: noteText, textRef: noteTextRef, setText: setNoteText } = useSyncedText("");
    const renameInputRef = useRef<InputRenderable>(null);
    const prevTabRef = useRef<string | null>(null);
    const lastSavedTextRef = useRef<Map<string, string>>(new Map());
    const loadedRef = useRef(false);
    const activeTab = tabs.find((tab) => tab.id === activeTabId);

    const saveQuickNotesIndex = useCallback((entries: QuickNoteEntry[]) => {
      notesFiles.saveQuickNotesIndex(entries).catch(() => {});
    }, [notesFiles]);

    const readActiveNoteText = useCallback(() => (
      textareaRef.current?.editBuffer.getText() ?? noteTextRef.current
    ), [noteTextRef]);

    const saveTab = useCallback((tabId: string | null) => {
      if (!tabId) return;
      if (!lastSavedTextRef.current.has(tabId)) return;
      const text = tabId === activeTabId ? readActiveNoteText() : noteTextRef.current;
      if (lastSavedTextRef.current.get(tabId) === text) return;

      lastSavedTextRef.current.set(tabId, text);
      notesFiles.save(notesFiles.quickNoteKey(tabId), text).catch(() => {});

      const updatedAt = Date.now();
      setTabs((prev) => {
        if (!prev.some((tab) => tab.id === tabId)) return prev;
        const next = prev.map((tab) => (tab.id === tabId ? { ...tab, updatedAt } : tab));
        saveQuickNotesIndex(next);
        return next;
      });
    }, [activeTabId, noteTextRef, notesFiles, readActiveNoteText, saveQuickNotesIndex]);

    useEffect(() => {
      if (loadedRef.current) return;
      loadedRef.current = true;
      notesFiles.loadQuickNotesIndex().then((entries) => {
        if (entries.length === 0) {
          const id = generateNoteId();
          const initial: QuickNoteEntry[] = [{ id, title: "New" }];
          lastSavedTextRef.current.set(id, "");
          setTabs(initial);
          setActiveTabId(id);
          saveQuickNotesIndex(initial);
        } else {
          setTabs(entries);
          setActiveTabId(entries[0]!.id);
        }
      });
    }, [notesFiles, saveQuickNotesIndex]);

    useEffect(() => {
      if (!activeTabId) {
        setNoteText("");
        return;
      }
      prevTabRef.current = activeTabId;
      let cancelled = false;
      notesFiles.load(notesFiles.quickNoteKey(activeTabId)).then((text) => {
        if (cancelled) return;
        lastSavedTextRef.current.set(activeTabId, text);
        setNoteText(text);
        textareaRef.current?.setText(text);
      }).catch(() => {
        if (cancelled) return;
        lastSavedTextRef.current.set(activeTabId, "");
        setNoteText("");
        textareaRef.current?.setText("");
      });
      return () => {
        cancelled = true;
      };
    }, [activeTabId, notesFiles, setNoteText]);

    useEffect(() => {
      if (!editing) saveTab(activeTabId);
    }, [activeTabId, editing, saveTab]);

    useEffect(() => {
      if (!focused && editing) setEditing(false);
    }, [editing, focused]);

    const addTab = useCallback(() => {
      saveTab(activeTabId);
      const id = generateNoteId();
      const entry: QuickNoteEntry = { id, title: "New" };
      lastSavedTextRef.current.set(id, "");
      setTabs((prev) => {
        const next = [...prev, entry];
        saveQuickNotesIndex(next);
        return next;
      });
      setActiveTabId(id);
      setNoteText("");
      setEditing(false);
      setRenaming(false);
    }, [activeTabId, saveQuickNotesIndex, saveTab, setNoteText]);

    const removeTab = useCallback((id: string) => {
      lastSavedTextRef.current.delete(id);
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          const newId = generateNoteId();
          const fresh: QuickNoteEntry[] = [{ id: newId, title: "New" }];
          lastSavedTextRef.current.set(newId, "");
          saveQuickNotesIndex(fresh);
          setActiveTabId(newId);
          setNoteText("");
          prevTabRef.current = null;
          return fresh;
        }
        saveQuickNotesIndex(next);
        if (activeTabId === id) {
          const idx = prev.findIndex((t) => t.id === id);
          const newActive = next[Math.min(idx, next.length - 1)]!;
          setActiveTabId(newActive.id);
          setNoteText("");
          prevTabRef.current = null;
        }
        return next;
      });
      notesFiles.delete(notesFiles.quickNoteKey(id)).catch(() => {});
      setEditing(false);
      setRenaming(false);
    }, [activeTabId, notesFiles, saveQuickNotesIndex, setNoteText]);

    const requestRemoveTab = useCallback(async (id: string) => {
      const tab = tabs.find((entry) => entry.id === id);
      const text = id === activeTabId
        ? readActiveNoteText()
        : await notesFiles.load(notesFiles.quickNoteKey(id));

      if (text.trim().length > 0) {
        const confirmed = await dialog.prompt<boolean>({
          closeOnClickOutside: true,
          content: (ctx: PromptContext<boolean>) => (
            <ConfirmDialog
              {...ctx}
              title="Delete note?"
              body={[
                `Delete "${formatDeleteNoteTitle(tab?.title ?? "Note")}"?`,
                "This note has content.",
                "Deleting it cannot be undone.",
              ]}
              confirmLabel="Delete"
              cancelLabel="Cancel"
              width={44}
              footer="Enter delete · Esc cancel"
            />
          ),
        }).catch(() => false);
        if (confirmed !== true) return;
      }

      removeTab(id);
    }, [activeTabId, dialog, notesFiles, readActiveNoteText, removeTab, tabs]);

    const startRename = useCallback(() => {
      if (!activeTab) return;
      setRenameValue(activeTab.title);
      setRenaming(true);
      setEditing(false);
    }, [activeTab]);

    const startRenameTab = useCallback((id: string) => {
      const tab = tabs.find((entry) => entry.id === id);
      if (!tab) return;
      if (id !== activeTabId) saveTab(activeTabId);
      setActiveTabId(id);
      setRenameValue(tab.title);
      setRenaming(true);
      setEditing(false);
    }, [activeTabId, saveTab, tabs]);

    const commitRename = useCallback(() => {
      const value = renameInputRef.current?.editBuffer.getText().trim() || renameValue.trim();
      if (!value || !activeTabId) {
        setRenaming(false);
        return;
      }
      setTabs((prev) => {
        const next = prev.map((t) => (t.id === activeTabId ? { ...t, title: value } : t));
        notesFiles.saveQuickNotesIndex(next).catch(() => {});
        return next;
      });
      setRenaming(false);
    }, [activeTabId, notesFiles, renameValue]);

    useShortcut((event) => {
      if (!focused) return;

      if (renaming) {
        if (event.name === "enter" || event.name === "return") {
          commitRename();
          return;
        }
        if (event.name === "escape") {
          setRenaming(false);
          return;
        }
        return;
      }

      const isEnter = event.name === "enter" || event.name === "return";
      if (isEnter && !editing) {
        setEditing(true);
        return;
      }
      if (event.name === "escape" && editing) {
        setEditing(false);
        return;
      }
      if (!editing) {
        if (event.name === "n" || event.name === "t") {
          addTab();
          return;
        }
        if (event.name === "w" && tabs.length > 0) {
          if (activeTabId) void requestRemoveTab(activeTabId);
          return;
        }
        if (event.name === "r") {
          startRename();
          return;
        }
        if ((event.name === "[" || event.name === "]") && tabs.length > 1) {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          if (idx < 0) return;
          const next = event.name === "]"
            ? (idx + 1) % tabs.length
            : (idx - 1 + tabs.length) % tabs.length;
          saveTab(activeTabId);
          setActiveTabId(tabs[next]!.id);
        }
      }
    }, { allowEditable: true });

    usePaneFooter("quick-notes", () => ({
      info: [
        { id: "edited", parts: [{ text: editing || renaming ? "editing" : formatLastEdited(activeTab?.updatedAt), tone: "muted" }] },
      ],
      hints: editing || renaming
        ? []
        : [
            { id: "new", key: "n", label: "ew", onPress: addTab },
            { id: "rename", key: "r", label: "ename", onPress: startRename, disabled: !activeTabId },
          ],
    }), [activeTab, activeTabId, addTab, editing, renaming, startRename]);

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box height={1}>
          <Tabs
            tabs={tabs.map((tab) => ({
              label: tab.title,
              value: tab.id,
              onClose: tabs.length > 1 ? (id) => { void requestRemoveTab(id); } : undefined,
              onDoubleClick: startRenameTab,
            }))}
            activeValue={activeTabId}
            onSelect={(id) => {
              if (id === activeTabId) return;
              saveTab(activeTabId);
              setActiveTabId(id);
              setEditing(false);
            }}
            compact
            variant="pill"
            closeMode="active"
            onAdd={addTab}
            focused={focused && !editing && !renaming}
          />
        </Box>
        {renaming && (
          <Box height={1} flexDirection="row" paddingLeft={1}>
            <Text fg={colors.textDim}>{"Rename: "}</Text>
            <Input
              ref={renameInputRef}
              initialValue={renameValue}
              focused={renaming}
              textColor={colors.text}
              backgroundColor={colors.panel}
              flexGrow={1}
              onChange={(val: string) => setRenameValue(val)}
            />
          </Box>
        )}
        <Box flexGrow={1} minHeight={0} paddingX={1} onMouseDown={() => { if (!editing && !renaming) setEditing(true); }}>
          {editing && !renaming ? (
            <MarkdownEditor
              textareaKey={activeTabId ?? "none"}
              focused={focused}
              initialValue={noteText}
              placeholder="Write notes..."
              onRef={(ref) => { textareaRef.current = ref; }}
              onChange={setNoteText}
            />
          ) : (
            <MarkdownNotePreview
              text={noteText}
              width={width}
              placeholder="Write notes..."
              onActivate={() => { if (!renaming) setEditing(true); }}
            />
          )}
        </Box>
      </Box>
    );
  };
}
