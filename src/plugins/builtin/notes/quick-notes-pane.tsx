import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Input, Text, type InputRenderable, type TextareaRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import { MarkdownEditor } from "../../../components/markdown-editor";
import { ConfirmDialog, EmptyState, Tabs, usePaneFooter } from "../../../components";
import { type PromptContext, useDialog } from "../../../ui/dialog";
import { usePluginAppActions } from "../../runtime";
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
    const { notify } = usePluginAppActions();
    const textareaRef = useRef<TextareaRenderable | null>(null);
    const [editing, setEditing] = useState(false);
    const [tabs, setTabs] = useState<QuickNoteEntry[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const [loadError, setLoadError] = useState<string | null>(null);
    const { text: noteText, textRef: noteTextRef, setText: setNoteText } = useSyncedText("");
    const renameInputRef = useRef<InputRenderable>(null);
    const prevTabRef = useRef<string | null>(null);
    const lastSavedTextRef = useRef<Map<string, string>>(new Map());
    const loadedTabIdRef = useRef<string | null>(null);
    const loadedRef = useRef(false);
    const activeTab = tabs.find((tab) => tab.id === activeTabId);

    const saveQuickNotesIndex = useCallback((entries: QuickNoteEntry[]) => {
      notesFiles.saveQuickNotesIndex(entries).catch((error) => {
        console.error("[notes] Failed to save notes index:", error);
        notify({ body: "Failed to save notes index. Check disk space and permissions.", type: "error" });
      });
    }, [notesFiles, notify]);

    const readActiveNoteText = useCallback(() => (
      textareaRef.current?.editBuffer.getText() ?? noteTextRef.current
    ), [noteTextRef]);

    const handleNoteChange = useCallback((value: string) => {
      if (activeTabId) {
        loadedTabIdRef.current = activeTabId;
      }
      setNoteText(value);
    }, [activeTabId, setNoteText]);

    const saveTab = useCallback((tabId: string | null) => {
      if (!tabId) return;
      const isActive = tabId === activeTabId;
      if (isActive && loadedTabIdRef.current !== activeTabId) return;
      if (!isActive && !lastSavedTextRef.current.has(tabId)) return;
      const text = isActive ? readActiveNoteText() : noteTextRef.current;
      if (lastSavedTextRef.current.get(tabId) === text) return;

      lastSavedTextRef.current.set(tabId, text);
      notesFiles.save(notesFiles.quickNoteKey(tabId), text).catch((error) => {
        console.error("[notes] Failed to save note:", error);
        notify({ body: "Failed to save note. Check disk space and permissions.", type: "error" });
      });

      const updatedAt = Date.now();
      setTabs((prev) => {
        if (!prev.some((tab) => tab.id === tabId)) return prev;
        const next = prev.map((tab) => (tab.id === tabId ? { ...tab, updatedAt } : tab));
        saveQuickNotesIndex(next);
        return next;
      });
    }, [activeTabId, noteTextRef, notesFiles, notify, readActiveNoteText, saveQuickNotesIndex]);

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
        loadedTabIdRef.current = null;
        setNoteText("");
        return;
      }
      prevTabRef.current = activeTabId;
      loadedTabIdRef.current = null;
      setNoteText("");
      setLoadError(null);
      textareaRef.current?.setText("");
      let cancelled = false;
      // The user can start typing before a slow load resolves; handleNoteChange
      // marks the buffer as owning this tab, and applying the loaded text then
      // would silently wipe what was typed.
      const applyLoaded = (text: string) => {
        if (cancelled || loadedTabIdRef.current === activeTabId) return;
        loadedTabIdRef.current = activeTabId;
        lastSavedTextRef.current.set(activeTabId, text);
        setNoteText(text);
        textareaRef.current?.setText(text);
      };
      notesFiles.load(notesFiles.quickNoteKey(activeTabId)).then(applyLoaded, (error: unknown) => {
        // Leave the tab unloaded so nothing can save over content we failed to read.
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
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
      notesFiles.delete(notesFiles.quickNoteKey(id)).catch((error) => {
        console.error("[notes] Failed to delete note:", error);
        notify({ body: "Failed to delete note. Check disk space and permissions.", type: "error" });
      });
      setEditing(false);
      setRenaming(false);
    }, [activeTabId, notesFiles, notify, saveQuickNotesIndex, setNoteText]);

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
        saveQuickNotesIndex(next);
        return next;
      });
      setRenaming(false);
    }, [activeTabId, renameValue, saveQuickNotesIndex]);

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
        if (event.name === "n") {
          addTab();
          return;
        }
        if (event.name === "w" && tabs.length > 0) {
          if (activeTabId) void requestRemoveTab(activeTabId);
          return;
        }
        // Not `r`: that is the app-wide refresh key.
        if (event.name === "t") {
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
      info: loadError
        ? [{ id: "load-error", parts: [{ text: loadError, tone: "warning" as const }] }]
        : [
            { id: "edited", parts: [{ text: editing || renaming ? "editing" : formatLastEdited(activeTab?.updatedAt), tone: "muted" as const }] },
          ],
      hints: editing || renaming
        ? []
        : [
            { id: "new", key: "n", label: "ew", onPress: addTab },
            { id: "title", key: "t", label: "itle", onPress: startRename, disabled: !activeTabId },
          ],
    }), [activeTab, activeTabId, addTab, editing, loadError, renaming, startRename]);

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
        <Box flexGrow={1} minHeight={0} paddingX={1} onMouseDown={() => { if (!editing && !renaming && !loadError) setEditing(true); }}>
          {loadError ? (
            <EmptyState
              title="This note could not be read."
              message={loadError}
              hint="Editing is disabled so the saved note is not overwritten. Fix the file, then reopen the pane."
            />
          ) : editing && !renaming ? (
            <MarkdownEditor
              textareaKey="editing"
              focused={focused}
              initialValue={noteText}
              placeholder="Write notes..."
              onRef={(ref) => { textareaRef.current = ref; }}
              onChange={handleNoteChange}
            />
          ) : (
            <MarkdownNotePreview
              text={noteText}
              width={width}
              placeholder="Write notes..."
              onActivate={() => { if (!renaming && !loadError) setEditing(true); }}
            />
          )}
        </Box>
      </Box>
    );
  };
}
