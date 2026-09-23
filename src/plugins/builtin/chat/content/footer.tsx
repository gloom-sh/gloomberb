import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ChatMessage, ChatUserSummary } from "../../../../api-client";
import { usePaneFooter, type PaneHint } from "../../../../components";
import { ChoiceDialog } from "../../../../components/ui/choice-dialog";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { ContextMenuItem } from "../../../../types/context-menu";
import { useRendererHost } from "../../../../ui";
import { useOptionalDialog, type PromptContext } from "../../../../ui/dialog";
import { hasPublicChatProfileInfo } from "../message/profile-popover";
import { chatMessageOpenTargets, type ChatOpenTarget } from "./open-targets";

/**
 * The chat pane's keys, shown in its footer and listed in its pane menu. The
 * hints are the bindings for everything but Enter and `i`, which the chat's
 * own handler owns because they depend on the composer and the selection.
 */
export function useChatFooter({
  composing,
  canSend,
  selectedIdx,
  selectedMessage,
  latestEditableMessageId,
  beginEditMessage,
  beginReplyTo,
  focusComposer,
  catalog,
  openTicker,
  currentUserId,
  profilePopoverUser,
  showProfilePopover,
  closeProfilePopover,
  notificationChannelId,
  notificationsEnabled,
  setChannelNotificationsEnabled,
  newChannelTeamId,
  openNewDm,
  openTeamChannel,
  canCycleChannels,
  cycleChannel,
  canFocusSidebar,
  focusChannelSidebar,
  jumpToMessage,
  needsProfileSetup,
  openProfileSetup,
}: {
  /**
   * The composer or the New DM overlay owns the keyboard. Hints about the
   * selected message drop out; the rest stay, so the footer does not come and
   * go (and move the transcript) each time the composer takes focus.
   */
  composing: boolean;
  canSend: boolean;
  selectedIdx: number;
  selectedMessage: ChatMessage | null;
  latestEditableMessageId: string | null;
  beginEditMessage: (index: number, options?: { deferFocus?: boolean }) => boolean;
  beginReplyTo: (index: number, options?: { deferFocus?: boolean }) => void;
  focusComposer: () => void;
  catalog: Record<string, InlineTickerCatalogEntry>;
  openTicker: (symbol: string) => void;
  currentUserId: string | undefined;
  profilePopoverUser: ChatUserSummary | null;
  showProfilePopover: (user: ChatUserSummary) => void;
  closeProfilePopover: () => void;
  /** The channel `m` mutes: the sidebar cursor's, else the open one. */
  notificationChannelId: string | null;
  notificationsEnabled: boolean;
  setChannelNotificationsEnabled: (channelId: string, enabled: boolean) => void;
  /** Set when the sidebar cursor is in a team section, so `n` adds a channel there. */
  newChannelTeamId: string | null;
  openNewDm: () => void;
  openTeamChannel: (teamId: string) => void;
  canCycleChannels: boolean;
  cycleChannel: (direction: 1 | -1) => boolean;
  canFocusSidebar: boolean;
  focusChannelSidebar: () => boolean;
  jumpToMessage: (messageId: string) => void;
  needsProfileSetup: boolean;
  openProfileSetup: () => void;
}) {
  const dialog = useOptionalDialog();
  const rendererHost = useRendererHost();
  const content = selectedMessage?.content ?? "";
  const openTargets = useMemo(() => chatMessageOpenTargets(content, catalog), [catalog, content]);

  const openTarget = useCallback((target: ChatOpenTarget) => {
    if (target.kind === "ticker") openTicker(target.symbol);
    else void rendererHost.openExternal(target.url);
  }, [openTicker, rendererHost]);

  // One target opens at once; several ask which, in the order the message reads.
  const openSelectedTargets = useCallback(async () => {
    const [first] = openTargets;
    if (!first) return;
    if (openTargets.length === 1 || !dialog) {
      openTarget(first);
      return;
    }
    const choices = openTargets.map((target, index) => ({
      id: String(index),
      label: target.kind === "ticker" ? `$${target.symbol}` : target.label,
      ...(target.kind === "link" && target.label !== target.url ? { description: target.url } : {}),
    }));
    const choice = await dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (context: PromptContext<string>) => (
        <ChoiceDialog {...context} title="Open" choices={choices} selectedChoiceId="0" />
      ),
    }).catch(() => undefined);
    const target = choice === undefined ? null : openTargets[Number(choice)];
    if (target) openTarget(target);
  }, [dialog, openTarget, openTargets]);

  const author = selectedMessage?.user ?? null;
  const authorHasProfile = !!author && (author.id === currentUserId || hasPublicChatProfileInfo(author));
  // A card opened from the keyboard follows the selection: moving on closes it.
  const keyboardProfileRef = useRef(false);
  const toggleAuthorProfile = useCallback(() => {
    if (!author) return;
    if (profilePopoverUser?.id === author.id) {
      keyboardProfileRef.current = false;
      closeProfilePopover();
      return;
    }
    keyboardProfileRef.current = true;
    showProfilePopover(author);
  }, [author, closeProfilePopover, profilePopoverUser?.id, showProfilePopover]);
  useEffect(() => {
    if (!keyboardProfileRef.current) return;
    keyboardProfileRef.current = false;
    closeProfilePopover();
  }, [closeProfilePopover, selectedIdx]);

  const canEdit = canSend && !!selectedMessage && selectedMessage.id === latestEditableMessageId;
  const replyToId = selectedMessage?.replyToId ?? null;
  const onlyTarget = openTargets.length === 1 ? openTargets[0]! : null;
  const openTargetTitle = onlyTarget
    ? onlyTarget.kind === "ticker" ? `Open $${onlyTarget.symbol}` : "Open Link"
    : openTargets.every((target) => target.kind === "ticker")
      ? "Open Ticker…"
      : openTargets.every((target) => target.kind === "link") ? "Open Link…" : "Open Link or Ticker…";

  // Actions run whatever the latest render holds, so a footer entry that did
  // not need redrawing never acts on a stale message list.
  const latest = useRef({
    beginEditMessage,
    beginReplyTo,
    cycleChannel,
    focusChannelSidebar,
    focusComposer,
    jumpToMessage,
    openNewDm,
    openProfileSetup,
    openSelectedTargets,
    openTeamChannel,
    selectedIdx,
    setChannelNotificationsEnabled,
    toggleAuthorProfile,
  });
  latest.current = {
    beginEditMessage,
    beginReplyTo,
    cycleChannel,
    focusChannelSidebar,
    focusComposer,
    jumpToMessage,
    openNewDm,
    openProfileSetup,
    openSelectedTargets,
    openTeamChannel,
    selectedIdx,
    setChannelNotificationsEnabled,
    toggleAuthorProfile,
  };

  usePaneFooter("chat", () => {
    const hints: PaneHint[] = [];
    // Nothing about the selection applies while typing.
    if (!composing && selectedMessage) {
      if (canSend) hints.push({ id: "reply", key: "Enter", label: "reply", title: "Reply", onPress: () => latest.current.beginReplyTo(latest.current.selectedIdx, { deferFocus: true }) });
      if (canEdit) hints.push({ id: "edit", key: "e", label: "dit", title: "Edit Message", onPress: () => { latest.current.beginEditMessage(latest.current.selectedIdx, { deferFocus: true }); } });
      if (openTargets.length > 0) hints.push({ id: "open", key: "o", label: "pen", title: openTargetTitle, onPress: () => { void latest.current.openSelectedTargets(); } });
      if (authorHasProfile) hints.push({ id: "profile", key: "p", label: "rofile", title: "Show Profile", onPress: () => latest.current.toggleAuthorProfile() });
    } else if (!composing && canSend) {
      hints.push({ id: "compose", key: "i", label: " compose", title: "Compose", onPress: () => queueMicrotask(() => latest.current.focusComposer()) });
    }
    if (canSend && notificationChannelId) {
      const channelId = notificationChannelId;
      hints.push({
        id: "notifications",
        key: "m",
        label: notificationsEnabled ? "ute" : " unmute",
        title: notificationsEnabled ? "Mute Channel" : "Unmute Channel",
        onPress: () => latest.current.setChannelNotificationsEnabled(channelId, !notificationsEnabled),
      });
    }
    if (canSend) {
      const teamId = newChannelTeamId;
      hints.push(teamId
        ? { id: "new", key: "n", label: "ew channel", title: "New Team Channel", onPress: () => latest.current.openTeamChannel(teamId) }
        : { id: "new", key: "n", label: "ew DM", title: "New DM", onPress: () => latest.current.openNewDm() });
    }

    const menu: ContextMenuItem[] = [];
    if (canCycleChannels) {
      menu.push(
        { id: "previous-channel", label: "Previous Channel", accelerator: "[", onSelect: () => { latest.current.cycleChannel(-1); } },
        { id: "next-channel", label: "Next Channel", accelerator: "]", onSelect: () => { latest.current.cycleChannel(1); } },
      );
    }
    if (canFocusSidebar) {
      menu.push({ id: "channel-list", label: "Channel List", accelerator: "Left", onSelect: () => { latest.current.focusChannelSidebar(); } });
    }
    if (replyToId) {
      menu.push({ id: "original-message", label: "Go to Original Message", onSelect: () => latest.current.jumpToMessage(replyToId) });
    }
    if (needsProfileSetup) {
      menu.push({ id: "profile-setup", label: "Set Up Profile", onSelect: () => latest.current.openProfileSetup() });
    }
    return { hints, menu };
  }, [
    authorHasProfile,
    canCycleChannels,
    canEdit,
    canFocusSidebar,
    canSend,
    composing,
    newChannelTeamId,
    needsProfileSetup,
    notificationChannelId,
    notificationsEnabled,
    openTargetTitle,
    openTargets.length,
    replyToId,
    selectedIdx,
    selectedMessage,
  ]);
}
