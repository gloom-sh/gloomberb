import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { EmptyState, Notice, Spinner, loadingText } from "../../../../components";
import { ListView, type ListViewItem } from "../../../../components/ui/list-view";
import { useShortcut } from "../../../../react/input";
import { colors } from "../../../../theme/colors";
import { Box, Text } from "../../../../ui";
import { isPlainKey } from "../../../../utils/keyboard";
import { usePluginAppActions } from "../../../runtime";
import { describeTeam, teamAccentHex, teamLabel, userHandle } from "./model";
import { openTeamPane } from "./pane-request";
import { teamStore } from "./store";

const NEW_TEAM_ID = "__new__";

/**
 * The Teams tab of the account pane: one list of teams and pending
 * invitations. Enter opens the team pane, where everything happens.
 */
export function TeamsAccountTab({ focused, width }: { focused: boolean; width: number }) {
  const { createPaneFromTemplate } = usePluginAppActions();
  const snapshot = useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    void teamStore.refresh();
  }, []);

  const items = useMemo<ListViewItem[]>(() => [
    ...snapshot.invitations.map((invitation) => ({
      id: `invitation:${invitation.id}`,
      label: `Invitation to ${invitation.team.name}`,
      description: `From ${userHandle(invitation.inviter)}. Enter to accept or decline.`,
      right: "NEW",
      category: "Invitations",
    })),
    ...snapshot.teams.map((team) => ({
      id: `team:${team.id}`,
      label: teamLabel(team),
      description: `${describeTeam(team)} · enter to open`,
      right: team.shortName,
      current: teamStore.getDefaultTeamId() === team.id,
    })),
    {
      id: NEW_TEAM_ID,
      label: "New team",
      description: "Name, short name, accent color. Needs Pro; joining is free.",
      right: "+",
    },
  ], [snapshot.invitations, snapshot.teams]);

  const activate = (item: ListViewItem) => {
    if (item.id === NEW_TEAM_ID) {
      openTeamPane(createPaneFromTemplate, { mode: "create" });
      return;
    }
    if (item.id.startsWith("invitation:")) {
      openTeamPane(createPaneFromTemplate, {});
      return;
    }
    const team = snapshot.teams.find((entry) => `team:${entry.id}` === item.id);
    if (team) openTeamPane(createPaneFromTemplate, { teamId: team.id });
  };

  useShortcut((event) => {
    if (!focused || event.targetEditable) return;
    if (isPlainKey(event, "down", "j")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIndex((index) => Math.min(items.length - 1, index + 1));
    } else if (isPlainKey(event, "up", "k")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (isPlainKey(event, "enter", "return")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const item = items[Math.min(selectedIndex, items.length - 1)];
      if (item) activate(item);
    }
  });

  const focusLabel =
    snapshot.focus === "all"
      ? "everything"
      : snapshot.focus === "personal"
        ? "personal only"
        : (teamStore.getTeam(snapshot.focus.teamId)?.name ?? "one team");

  return (
    <Box flexDirection="column" width={width} gap={1}>
      {snapshot.loading && !snapshot.loaded ? (
        <Spinner label={loadingText("teams")} />
      ) : snapshot.error ? (
        <Notice tone="negative">{snapshot.error}</Notice>
      ) : snapshot.teams.length === 0 ? (
        <EmptyState title="You are not in a team yet." hint="Create one or open an invite link a teammate sent you." />
      ) : (
        <Text fg={colors.textDim}>{`Focus: ${focusLabel}`}</Text>
      )}
      <ListView
        items={items}
        selectedIndex={Math.min(selectedIndex, Math.max(0, items.length - 1))}
        onSelect={setSelectedIndex}
        onActivate={activate}
        showSelectedDescription
        surface="plain"
        renderRow={(item, state) => {
          const team = item.id.startsWith("team:")
            ? snapshot.teams.find((entry) => `team:${entry.id}` === item.id)
            : null;
          const accent = team ? teamAccentHex(team.accentColor) : colors.textDim;
          const fg = state.selected ? colors.selectedText : colors.text;
          return (
            <Box flexDirection="row" width="100%">
              <Text fg={team && !state.selected ? accent : fg}>{item.label}</Text>
              <Box flexGrow={1} />
              <Text fg={state.selected ? fg : colors.textMuted}>{item.right ?? ""}</Text>
            </Box>
          );
        }}
      />
    </Box>
  );
}
