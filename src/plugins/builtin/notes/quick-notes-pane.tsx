import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type InputRenderable, type TextareaRenderable } from "../../../ui";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import type { PaneProps } from "../../../types/plugin";
import { colors } from "../../../theme/colors";
import { MarkdownEditor } from "../../../components/markdown-editor";
import { ConfirmDialog, EmptyState, Tabs, TextField, usePaneFooter, usePaneHeaderTabs } from "../../../components";
import { type PromptContext, useDialog } from "../../../ui/dialog";
import { usePluginAppActions, usePluginPaneState } from "../../runtime";
import { debugLog } from "../../../utils/debug-log";
import { MarkdownNotePreview } from "./markdown-note-preview";
import {
  formatDeleteNoteTitle,
  formatLastEdited,
  generateNoteId,
  type QuickNoteEntry,
} from "./model";
import { chooseNoteOwner, ownerColor, ownerLabel, resolveNoteConflict, useNoteTeams } from "./owner";
import { NoteConflictError, type NoteOwner, noteOwnerKey, type NotesStoreRegistry } from "./store";
import { useSyncedText } from "./text-state";

const notesLog = debugLog.createLogger("notes");

/** A tab in the pane: a quick note plus who owns it. */
interface OwnedQuickNote extends QuickNoteEntry {
  owner: NoteOwner;
}

export function createQuickNotesPane(registry: NotesStoreRegistry) {
  return function QuickNotesPane({ focused, width }: PaneProps) {
    const dialog = useDialog();
    const { notify } = usePluginAppActions();
    const teams = useNoteTeams();
    const teamKey = teams.map((team) => team.id).join(",");
    const owners = useMemo<NoteOwner[]>(
      () => [{ kind: "user" }, ...teams.map((team) => ({ kind: "team" as const, teamId: team.id }))],
      // teamKey stands in for the team list identity.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [teamKey],
    );
    const storeFor = useCallback((owner: NoteOwner) => registry.forOwner(owner), []);
    const tabOwner = useCallback((tabId: string | null, list: readonly OwnedQuickNote[]): NoteOwner => (
      list.find((tab) => tab.id === tabId)?.owner ?? { kind: "user" }
    ), []);
    const textareaRef = useRef<TextareaRenderable | null>(null);
    const [editing, setEditing] = useState(false);
    const [tabs, setTabs] = useState<OwnedQuickNote[]>([]);
    const tabsRef = useRef<OwnedQuickNote[]>([]);
    tabsRef.current = tabs;
    const [activeTabId, setActiveTabId] = usePluginPaneState<string | null>("activeNoteId", null);
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

    const saveQuickNotesIndex = useCallback((entries: OwnedQuickNote[]) => {
      // Each owner keeps its own index; a title change only touches that store.
      const byOwner = new Map<string, { owner: NoteOwner; entries: QuickNoteEntry[] }>();
      for (const entry of entries) {
        const key = noteOwnerKey(entry.owner);
        const bucket = byOwner.get(key) ?? { owner: entry.owner, entries: [] };
        bucket.entries.push({ id: entry.id, title: entry.title, ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}) });
        byOwner.set(key, bucket);
      }
      for (const owner of owners) {
        const bucket = byOwner.get(noteOwnerKey(owner));
        const store = storeFor(owner);
        if (store.readOnly) continue;
        store.saveQuickNotesIndex(bucket?.entries ?? []).catch((error) => {
          notesLog.error("Failed to save notes index", { error: error instanceof Error ? error.message : String(error) });
          notify({ body: error instanceof Error ? error.message : "Failed to save notes index.", type: "error" });
        });
      }
    }, [notify, owners, storeFor]);

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
      const owner = tabOwner(tabId, tabsRef.current);
      const store = storeFor(owner);
      if (store.readOnly) return;
      const key = store.quickNoteKey(tabId);
      store.save(key, text).catch(async (error: unknown) => {
        if (error instanceof NoteConflictError) {
          lastSavedTextRef.current.delete(tabId);
          const choice = await resolveNoteConflict(dialog, error);
          const cloud = registry.cloud(owner);
          if (choice === "reload") {
            const theirs = error.current?.content ?? "";
            if (cloud && error.current) cloud.acceptCurrent(key, error.current);
            lastSavedTextRef.current.set(tabId, theirs);
            if (loadedTabIdRef.current === tabId) {
              setNoteText(theirs);
              textareaRef.current?.setText(theirs);
            }
          } else if (choice === "overwrite") {
            if (cloud && error.current) cloud.acceptCurrent(key, error.current);
            lastSavedTextRef.current.set(tabId, text);
            await store.save(key, text).catch((again: unknown) => {
              notify({ body: again instanceof Error ? again.message : "Could not save the note.", type: "error" });
            });
          }
          return;
        }
        notesLog.error("Failed to save note", { error: error instanceof Error ? error.message : String(error) });
        notify({ body: error instanceof Error ? error.message : "Failed to save note.", type: "error" });
      });

      const updatedAt = Date.now();
      setTabs((prev) => {
        if (!prev.some((tab) => tab.id === tabId)) return prev;
        const next = prev.map((tab) => (tab.id === tabId ? { ...tab, updatedAt } : tab));
        saveQuickNotesIndex(next);
        return next;
      });
    }, [activeTabId, dialog, noteTextRef, notify, readActiveNoteText, saveQuickNotesIndex, setNoteText, storeFor, tabOwner]);

    useEffect(() => {
      // Mine first, then each team's notes; reloads when the team list changes.
      let cancelled = false;
      void Promise.all(owners.map(async (owner) => {
        try {
          return (await storeFor(owner).loadQuickNotesIndex()).map((entry) => ({ ...entry, owner }));
        } catch {
          return [] as OwnedQuickNote[];
        }
      })).then((lists) => {
        if (cancelled) return;
        const entries = lists.flat();
        if (entries.length === 0) {
          if (loadedRef.current) return;
          const id = generateNoteId();
          const initial: OwnedQuickNote[] = [{ id, title: "New", owner: { kind: "user" } }];
          lastSavedTextRef.current.set(id, "");
          setTabs(initial);
          setActiveTabId(id);
          saveQuickNotesIndex(initial);
        } else {
          setTabs((previous) => {
            // Keep a tab the person just added locally while the server catches up.
            const known = new Set(entries.map((entry) => entry.id));
            const pending = previous.filter((entry) => !known.has(entry.id) && lastSavedTextRef.current.has(entry.id));
            return [...entries, ...pending];
          });
          setActiveTabId((current) => (current && entries.some((entry) => entry.id === current) ? current : entries[0]!.id));
        }
        loadedRef.current = true;
      });
      return () => {
        cancelled = true;
      };
    }, [owners, saveQuickNotesIndex, storeFor]);

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
      const store = storeFor(tabOwner(activeTabId, tabsRef.current));
      store.load(store.quickNoteKey(activeTabId)).then(applyLoaded, (error: unknown) => {
        // Leave the tab unloaded so nothing can save over content we failed to read.
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
      return () => {
        cancelled = true;
      };
    }, [activeTabId, setNoteText, storeFor, tabOwner]);

    useEffect(() => {
      if (!editing) saveTab(activeTabId);
    }, [activeTabId, editing, saveTab]);

    useEffect(() => {
      if (!focused && editing) setEditing(false);
    }, [editing, focused]);

    const addTab = useCallback(async () => {
      saveTab(activeTabId);
      const owner = await chooseNoteOwner(dialog, teams);
      if (!owner) return;
      if (storeFor(owner).readOnly) {
        notify({ body: `${ownerLabel(owner, teams)} notes are read-only right now.`, type: "info" });
        return;
      }
      const id = generateNoteId();
      const entry: OwnedQuickNote = { id, title: "New", owner };
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
    }, [activeTabId, dialog, notify, saveQuickNotesIndex, saveTab, setNoteText, storeFor, teams]);

    const removeTab = useCallback((id: string) => {
      lastSavedTextRef.current.delete(id);
      const owner = tabOwner(id, tabsRef.current);
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          const newId = generateNoteId();
          const fresh: OwnedQuickNote[] = [{ id: newId, title: "New", owner: { kind: "user" } }];
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
      const store = storeFor(owner);
      store.delete(store.quickNoteKey(id)).catch((error) => {
        notesLog.error("Failed to delete note", { error: error instanceof Error ? error.message : String(error) });
        notify({ body: error instanceof Error ? error.message : "Failed to delete note.", type: "error" });
      });
      setEditing(false);
      setRenaming(false);
    }, [activeTabId, notify, saveQuickNotesIndex, setNoteText, storeFor, tabOwner]);

    const requestRemoveTab = useCallback(async (id: string) => {
      const tab = tabs.find((entry) => entry.id === id);
      const store = storeFor(tab?.owner ?? { kind: "user" });
      const text = id === activeTabId
        ? readActiveNoteText()
        : await store.load(store.quickNoteKey(id));

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
    }, [activeTabId, dialog, readActiveNoteText, removeTab, storeFor, tabs]);

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

    const deleteActiveNote = useCallback(() => {
      if (activeTabId) void requestRemoveTab(activeTabId);
    }, [activeTabId, requestRemoveTab]);

    // n, t and d are footer hints, which bind them without modifiers, so the
    // shell's Ctrl+W or Cmd+N never adds or deletes a note.
    useShortcut((event) => {
      if (!focused) return;

      if (renaming) {
        if (isPlainKey(event, "enter", "return")) {
          event.preventDefault();
          commitRename();
          return;
        }
        if (isPlainKey(event, "escape")) {
          event.preventDefault();
          setRenaming(false);
        }
        return;
      }

      // A note that failed to load stays read-only, as it does for a click.
      if (isPlainKey(event, "enter", "return") && !editing && !loadError) {
        event.preventDefault();
        setEditing(true);
        return;
      }
      if (isPlainKey(event, "escape") && editing) {
        event.preventDefault();
        setEditing(false);
        return;
      }
      if (!editing && isPlainKey(event, "[", "]") && tabs.length > 1) {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx < 0) return;
        event.preventDefault();
        const next = event.name === "]"
          ? (idx + 1) % tabs.length
          : (idx - 1 + tabs.length) % tabs.length;
        saveTab(activeTabId);
        setActiveTabId(tabs[next]!.id);
      }
    }, { allowEditable: true });

    // Deleting the only note when it is empty just swaps in another empty one,
    // and a note that failed to load reads as empty, so it would go unconfirmed.
    const canDelete = !!activeTabId && !loadError && (tabs.length > 1 || noteText.trim().length > 0);

    usePaneFooter("quick-notes", () => ({
      info: loadError
        ? [{ id: "load-error", parts: [{ text: loadError, tone: "warning" as const }] }]
        : [
            { id: "edited", parts: [{ text: editing || renaming ? "editing" : formatLastEdited(activeTab?.updatedAt), tone: "muted" as const }] },
          ],
      hints: editing || renaming
        ? []
        : [
            { id: "new", key: "n", label: "ew", title: "New Note", onPress: () => { void addTab(); } },
            // Not `r`: that is the app-wide refresh key.
            { id: "title", key: "t", label: "itle", title: "Rename Note", onPress: startRename, disabled: !activeTabId },
            { id: "delete", key: "d", label: "elete", title: "Delete Note", onPress: deleteActiveNote, disabled: !canDelete },
          ],
    }), [activeTab, activeTabId, addTab, canDelete, deleteActiveNote, editing, loadError, renaming, startRename]);

    const noteTabs = tabs.map((tab) => ({
      label: tab.owner.kind === "team" ? `${ownerLabel(tab.owner, teams)} ${tab.title}` : tab.title,
      value: tab.id,
      ...(tab.owner.kind === "team" ? { fg: ownerColor(tab.owner, teams) } : {}),
      onClose: tabs.length > 1 ? (id: string) => { void requestRemoveTab(id); } : undefined,
      onDoubleClick: startRenameTab,
    }));
    const selectTab = (id: string) => {
      if (id === activeTabId) return;
      saveTab(activeTabId);
      setActiveTabId(id);
      setEditing(false);
    };
    const tabsInHeader = usePaneHeaderTabs({
      tabs: noteTabs,
      activeValue: activeTabId,
      onSelect: selectTab,
      focused: focused && !editing && !renaming,
      closeMode: "active",
      onAdd: () => { void addTab(); },
      // New, Rename and Delete Note are footer hints, so already in the pane menu.
      paneMenu: false,
    });

    return (
      <Box flexDirection="column" flexGrow={1}>
        {!tabsInHeader && (
          <Box height={1}>
            <Tabs
              tabs={noteTabs}
              activeValue={activeTabId}
              onSelect={selectTab}
              compact
              variant="pill"
              closeMode="active"
              onAdd={() => { void addTab(); }}
              paneMenu={false}
              focused={focused && !editing && !renaming}
            />
          </Box>
        )}
        {renaming && (
          <Box height={1} flexDirection="row" paddingLeft={1}>
            <Text fg={colors.textDim}>{"Rename: "}</Text>
            <TextField
              inputRef={renameInputRef}
              value={renameValue}
              focused={renaming}
              textColor={colors.text}
              backgroundColor={colors.panel}
              width={Math.max(1, width - 10)}
              variant="plain"
              onChange={setRenameValue}
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
