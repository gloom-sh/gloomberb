import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../../../components/ui/button";
import { colors } from "../../../../theme/colors";
import { Box, Span, Text, TextAttributes, useCommandBarShortcut } from "../../../../ui";
import { usePluginAppActions } from "../../../runtime";
import { chatController } from "../../chat/controller";
import { countTeamUpdates, teamAccentHex, teamIdFromChannelId } from "./model";
import { openTeamPane } from "./pane-request";
import { teamStore } from "./store";

/**
 * One chip per team in the status bar, in the team's accent, with the unread
 * chat count and the number of pending cards (invites, layout updates). Hidden
 * teams under FOCUS keep their chip so the lens is visible, dimmed. A click
 * opens the team pane on that team.
 */
export function TeamStatusWidget() {
  const { createPaneFromTemplate } = usePluginAppActions();
  // The status bar takes no keyboard focus; each chip names the command instead.
  const commandBarKey = useCommandBarShortcut();
  const snapshot = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  );
  // The chat controller builds a fresh snapshot per call, so it cannot back
  // useSyncExternalStore; subscribe and keep only what the chips show.
  const [unreadByChannel, setUnreadByChannel] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => chatController.subscribe((chat) => {
    setUnreadByChannel((previous) => {
      const next = new Map<string, number>();
      for (const state of chat.channelStates) {
        if (state.channelId.startsWith("team:") && state.unreadCount > 0) next.set(state.channelId, state.unreadCount);
      }
      if (next.size === previous.size && [...next].every(([id, count]) => previous.get(id) === count)) return previous;
      return next;
    });
  }), []);
  if (snapshot.teams.length === 0) return null;

  const updates = countTeamUpdates(snapshot.notifications);

  return (
    <Box flexDirection="row" paddingRight={1}>
      {snapshot.teams.map((team) => {
        const accent = teamAccentHex(team.accentColor);
        let unread = 0;
        for (const [channelId, count] of unreadByChannel) {
          if (teamIdFromChannelId(channelId) === team.id) unread += count;
        }
        const cards = updates.get(team.id) ?? 0;
        const muted =
          snapshot.focus === "personal" ||
          (typeof snapshot.focus === "object" && snapshot.focus.teamId !== team.id);
        const count = unread + cards;
        return (
          <Button
            key={team.id}
            label={`${team.name}: open team`}
            title={`Open ${team.name} (${commandBarKey}, then TEAM ${team.shortName})`}
            variant="plain"
            compact
            stopPropagation
            onPress={() => openTeamPane(createPaneFromTemplate, { teamId: team.id })}
          >
            <Text fg={muted ? colors.textMuted : accent} attributes={count > 0 && !muted ? TextAttributes.BOLD : 0}>
              <Span fg={muted ? colors.textMuted : accent}>●</Span>
              {` ${team.shortName}`}
            </Text>
            {count > 0 ? (
              <Text fg={muted ? colors.textMuted : accent} attributes={TextAttributes.BOLD}>{`[${count}]`}</Text>
            ) : null}
            <Text> </Text>
          </Button>
        );
      })}
    </Box>
  );
}
