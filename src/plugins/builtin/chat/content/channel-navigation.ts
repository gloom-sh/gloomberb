import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MutableRefObject } from "react";
import type { ChatChannel } from "../../../../api-client";
import { useThrottledCommitValue } from "../../../../react/use-throttled-commit-value";
import { teamStore } from "../../cloud/team/store";
import { chatSidebarStore } from "../sidebar-store";
import {
  buildChatSidebarRows,
  chatSidebarHeaderKey,
  isChatSidebarHeader,
  type ChatSidebarHeaderRow,
  type ChatSidebarRow,
} from "../sidebar-rows";
import {
  DEFAULT_CHAT_CHANNEL_ID,
  normalizeChannelId,
} from "../channels";

const CHANNEL_NAVIGATION_COMMIT_DELAY_MS = 150;

function isConversationChannelId(channelId: string): boolean {
  return channelId.startsWith("dm:") || channelId.startsWith("grp:") || channelId.startsWith("group:");
}

function toggleSidebarSection(row: ChatSidebarHeaderRow): void {
  if (row.kind === "team-header") teamStore.toggleTeamCollapsed(row.teamId);
  else chatSidebarStore.toggleSectionCollapsed(row.kind === "public-header" ? "public" : "direct");
}

export function useChatChannelNavigation({
  blurInput,
  canCreateConversation = false,
  channelId,
  channelIdRef,
  channels,
  channelsLoading,
  focused,
  inputFocused,
  onChannelChange,
  resetTranscriptSelection,
  showChannelSidebar,
}: {
  blurInput: () => void;
  /** Whether the sidebar draws a DMs header with no DMs under it yet. */
  canCreateConversation?: boolean;
  channelId: string;
  channelIdRef: MutableRefObject<string>;
  channels: ChatChannel[];
  channelsLoading: boolean;
  focused: boolean;
  inputFocused: boolean;
  onChannelChange?: (channelId: string) => void;
  resetTranscriptSelection: () => void;
  showChannelSidebar: boolean;
}): {
  cycleChannel: (direction: 1 | -1) => boolean;
  expandDirectSection: () => void;
  focusChannelSidebar: () => boolean;
  focusChatContent: () => boolean;
  moveSidebarChannelSelection: (direction: "up" | "down") => boolean;
  moveSidebarToEdge: (edge: "first" | "last") => boolean;
  selectSidebarChannel: (channelId: string) => void;
  setSidebarFocused: (nextFocused: boolean) => void;
  setSidebarSectionExpanded: (expanded: boolean | "toggle") => boolean;
  sidebarCursorChannelId: string;
  sidebarCursorRow: ChatSidebarRow | null;
  sidebarFocused: boolean;
  sidebarFocusedRef: MutableRefObject<boolean>;
  sidebarHeaderCursor: string | null;
} {
  const [sidebarFocused, setSidebarFocusedState] = useState(false);
  const sidebarFocusedRef = useRef(false);
  const setSidebarFocused = useCallback((nextFocused: boolean) => {
    sidebarFocusedRef.current = nextFocused;
    setSidebarFocusedState((current) => (current === nextFocused ? current : nextFocused));
  }, []);
  const expandDirectSection = useCallback(() => {
    chatSidebarStore.setSectionCollapsed("direct", false);
  }, []);
  const teamSnapshot = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  );
  const collapsedSections = useSyncExternalStore(
    (onChange) => chatSidebarStore.subscribe(onChange),
    () => chatSidebarStore.getSnapshot().collapsedSections,
  );
  // The sidebar's own rows, headers included, so keyboard navigation lands on
  // exactly what is drawn and never inside a folded section.
  const sidebarRows = useMemo(() => buildChatSidebarRows({
    channels,
    collapsedSections,
    collapsedTeams: teamSnapshot.collapsedTeams,
    canCreateConversation,
    getTeam: (teamId) => teamStore.getTeam(teamId),
  }), [canCreateConversation, channels, collapsedSections, teamSnapshot.collapsedTeams, teamSnapshot.teams]);
  // Set while the cursor rests on a section header rather than a channel; the
  // channel cursor keeps its place underneath.
  const [sidebarHeaderCursor, setSidebarHeaderCursorState] = useState<string | null>(null);
  const sidebarHeaderCursorRef = useRef<string | null>(null);
  const setSidebarHeaderCursor = useCallback((key: string | null) => {
    sidebarHeaderCursorRef.current = key;
    setSidebarHeaderCursorState((current) => (current === key ? current : key));
  }, []);

  const changeChannel = useCallback((nextChannelId: string) => {
    const normalized = normalizeChannelId(nextChannelId);
    if (normalized === channelIdRef.current) return;
    channelIdRef.current = normalized;
    resetTranscriptSelection();
    onChannelChange?.(normalized);
  }, [channelIdRef, onChannelChange, resetTranscriptSelection]);
  const {
    value: sidebarCursorChannelId,
    valueRef: sidebarCursorChannelIdRef,
    setValue: setSidebarCursorChannelId,
    flushValue: flushSidebarCursorChannelId,
    replaceValue: replaceSidebarCursorChannelId,
  } = useThrottledCommitValue(channelId, changeChannel, CHANNEL_NAVIGATION_COMMIT_DELAY_MS);

  useEffect(() => {
    if (!onChannelChange || channelsLoading || channels.length === 0) return;
    if (channels.some((channel) => channel.id === channelId)) return;
    // DM/group panes can remount before the private channel catalog is refreshed.
    if (isConversationChannelId(channelId)) return;
    const fallbackChannelId = channels.find((channel) => channel.id === DEFAULT_CHAT_CHANNEL_ID)?.id
      ?? channels[0]?.id;
    if (fallbackChannelId) {
      changeChannel(fallbackChannelId);
    }
  }, [changeChannel, channelId, channels, channelsLoading, onChannelChange]);

  useEffect(() => {
    const activeChannel = channels.find((channel) => channel.id === channelId);
    if (activeChannel?.kind === "direct" || activeChannel?.kind === "group") {
      expandDirectSection();
    }
  }, [channelId, channels, expandDirectSection]);

  const cycleChannel = useCallback((direction: 1 | -1) => {
    if (channels.length <= 1 || !onChannelChange) return false;
    const currentIndex = Math.max(0, channels.findIndex((channel) => channel.id === channelIdRef.current));
    const nextIndex = (currentIndex + direction + channels.length) % channels.length;
    const nextChannel = channels[nextIndex];
    if (!nextChannel) return false;
    setSidebarHeaderCursor(null);
    setSidebarCursorChannelId(nextChannel.id, { immediate: true });
    return true;
  }, [channelIdRef, channels, onChannelChange, setSidebarCursorChannelId, setSidebarHeaderCursor]);

  const focusChannelSidebar = useCallback(() => {
    if (!showChannelSidebar || !onChannelChange) return false;
    if (inputFocused) {
      blurInput();
    }
    resetTranscriptSelection();
    replaceSidebarCursorChannelId(channelId);
    // The open channel may sit in a folded section; the cursor then starts on
    // that section's header, which is what the sidebar shows for it.
    const channel = channels.find((entry) => entry.id === channelId);
    const drawn = sidebarRows.some((row) => row.kind === "channel" && row.channel.id === channelId);
    setSidebarHeaderCursor(channel && !drawn ? chatSidebarHeaderKey(channel) : null);
    setSidebarFocused(true);
    return true;
  }, [
    blurInput,
    channelId,
    channels,
    inputFocused,
    onChannelChange,
    replaceSidebarCursorChannelId,
    resetTranscriptSelection,
    setSidebarFocused,
    setSidebarHeaderCursor,
    showChannelSidebar,
    sidebarRows,
  ]);

  const focusChatContent = useCallback(() => {
    if (!showChannelSidebar) return false;
    flushSidebarCursorChannelId(sidebarCursorChannelIdRef.current);
    setSidebarHeaderCursor(null);
    setSidebarFocused(false);
    return true;
  }, [flushSidebarCursorChannelId, setSidebarFocused, setSidebarHeaderCursor, showChannelSidebar, sidebarCursorChannelIdRef]);

  const cursorRowIndex = useCallback(() => {
    const headerKey = sidebarHeaderCursorRef.current;
    return headerKey
      ? sidebarRows.findIndex((row) => row.key === headerKey)
      : sidebarRows.findIndex((row) => row.kind === "channel" && row.channel.id === sidebarCursorChannelIdRef.current);
  }, [sidebarCursorChannelIdRef, sidebarRows]);

  const moveSidebarCursorTo = useCallback((row: ChatSidebarRow) => {
    if (row.kind === "channel") {
      setSidebarHeaderCursor(null);
      setSidebarCursorChannelId(row.channel.id);
    } else {
      setSidebarHeaderCursor(row.key);
    }
  }, [setSidebarCursorChannelId, setSidebarHeaderCursor]);

  const moveSidebarChannelSelection = useCallback((direction: "up" | "down") => {
    if (!showChannelSidebar || sidebarRows.length <= 1 || !onChannelChange) return false;
    const currentIndex = cursorRowIndex();
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = direction === "down"
      ? Math.min(baseIndex + 1, sidebarRows.length - 1)
      : Math.max(baseIndex - 1, 0);
    const nextRow = sidebarRows[nextIndex];
    if (!nextRow || nextIndex === baseIndex) return true;
    moveSidebarCursorTo(nextRow);
    return true;
  }, [cursorRowIndex, moveSidebarCursorTo, onChannelChange, showChannelSidebar, sidebarRows]);

  const moveSidebarToEdge = useCallback((edge: "first" | "last") => {
    if (!showChannelSidebar || !onChannelChange) return false;
    const channelRows = sidebarRows.filter((row) => row.kind === "channel");
    const pool = channelRows.length > 0 ? channelRows : sidebarRows;
    const target = edge === "first" ? pool[0] : pool[pool.length - 1];
    if (target) moveSidebarCursorTo(target);
    return true;
  }, [moveSidebarCursorTo, onChannelChange, showChannelSidebar, sidebarRows]);

  /** Folds or unfolds the section whose header has the cursor; false when a channel has it. */
  const setSidebarSectionExpanded = useCallback((expanded: boolean | "toggle") => {
    const row = sidebarRows.find((entry) => entry.key === sidebarHeaderCursorRef.current);
    if (!row || !isChatSidebarHeader(row)) return false;
    if (expanded === "toggle" || row.expanded !== expanded) toggleSidebarSection(row);
    return true;
  }, [sidebarRows]);

  const sidebarCursorRow = useMemo(() => (
    sidebarHeaderCursor
      ? sidebarRows.find((row) => row.key === sidebarHeaderCursor) ?? null
      : sidebarRows.find((row) => row.kind === "channel" && row.channel.id === sidebarCursorChannelId) ?? null
  ), [sidebarCursorChannelId, sidebarHeaderCursor, sidebarRows]);

  const selectSidebarChannel = useCallback((nextChannelId: string) => {
    setSidebarHeaderCursor(null);
    setSidebarCursorChannelId(nextChannelId, { immediate: true });
  }, [setSidebarCursorChannelId, setSidebarHeaderCursor]);

  useEffect(() => {
    if (focused && showChannelSidebar) return;
    setSidebarFocused(false);
    setSidebarHeaderCursor(null);
  }, [focused, setSidebarFocused, setSidebarHeaderCursor, showChannelSidebar]);

  // A header that stopped being drawn (its team left) cannot hold the cursor.
  useEffect(() => {
    if (sidebarHeaderCursor && !sidebarRows.some((row) => row.key === sidebarHeaderCursor)) {
      setSidebarHeaderCursor(null);
    }
  }, [setSidebarHeaderCursor, sidebarHeaderCursor, sidebarRows]);

  return {
    cycleChannel,
    expandDirectSection,
    focusChannelSidebar,
    focusChatContent,
    moveSidebarChannelSelection,
    moveSidebarToEdge,
    selectSidebarChannel,
    setSidebarFocused,
    setSidebarSectionExpanded,
    sidebarCursorChannelId,
    sidebarCursorRow,
    sidebarFocused,
    sidebarFocusedRef,
    sidebarHeaderCursor,
  };
}
