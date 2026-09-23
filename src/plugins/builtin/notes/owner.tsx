import { useSyncExternalStore } from "react";
import type { TeamSummary } from "../../../api-client";
import { ChoiceDialog } from "../../../components/ui/choice-dialog";
import { QueryBar } from "../../../components/ui/query-bar";
import { Box, Text } from "../../../ui";
import type { DialogApi, PromptContext } from "../../../ui/dialog";
import { colors } from "../../../theme/colors";
import { teamAccentHex, teamPrefix } from "../cloud/team/model";
import { teamStore } from "../cloud/team/store";
import { NoteConflictError, type NoteOwner, noteOwnerKey } from "./store";

export function useNoteTeams(): TeamSummary[] {
  return useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  ).teams;
}

/** The owner a new note defaults to: the focused team, else me. */
export function defaultNoteOwner(): NoteOwner {
  const teamId = teamStore.getDefaultTeamId();
  return teamId ? { kind: "team", teamId } : { kind: "user" };
}

export function ownerLabel(owner: NoteOwner, teams: readonly TeamSummary[]): string {
  if (owner.kind === "user") return "Me";
  const team = teams.find((entry) => entry.id === owner.teamId);
  return team ? teamPrefix(team) : "Team";
}

export function ownerColor(owner: NoteOwner, teams: readonly TeamSummary[]): string {
  if (owner.kind === "user") return colors.textDim;
  const team = teams.find((entry) => entry.id === owner.teamId);
  return team ? teamAccentHex(team.accentColor) : colors.textDim;
}

/** Me plus one choice per team. Hidden when there are no teams. */
export function NoteOwnerStrip({
  owner,
  teams,
  onSelect,
  width,
}: {
  owner: NoteOwner;
  teams: readonly TeamSummary[];
  onSelect: (owner: NoteOwner) => void;
  width: number;
}) {
  if (teams.length === 0) return null;
  const options = [
    { label: "Me", value: "user" },
    ...teams.map((team) => ({ label: teamPrefix(team), value: `team:${team.id}` })),
  ];
  return (
    <QueryBar
      width={width}
      filters={[{
        id: "owner",
        label: "Owner",
        inline: true,
        value: noteOwnerKey(owner),
        options,
        onChange: (value: string) => onSelect(value === "user" ? { kind: "user" } : { kind: "team", teamId: value.slice("team:".length) }),
      }]}
    />
  );
}

/** Where a new note goes, asked only when there is a choice. */
export async function chooseNoteOwner(dialog: DialogApi, teams: readonly TeamSummary[]): Promise<NoteOwner | null> {
  if (teams.length === 0) return { kind: "user" };
  const preferred = defaultNoteOwner();
  const choice = await dialog.prompt<string>({
    closeOnClickOutside: true,
    content: (context: PromptContext<string>) => (
      <ChoiceDialog
        {...context}
        title="New note for"
        choices={[
          { id: "user", label: "Me", description: "Only you see it." },
          ...teams.map((team) => ({ id: `team:${team.id}`, label: `${teamPrefix(team)} ${team.name}`, description: "Every member can read and edit it." })),
        ]}
        selectedChoiceId={noteOwnerKey(preferred)}
      />
    ),
  }).catch(() => undefined);
  if (!choice) return null;
  return choice === "user" ? { kind: "user" } : { kind: "team", teamId: choice.slice("team:".length) };
}

export type NoteConflictChoice = "reload" | "overwrite" | "keep";

/**
 * A teammate saved since this note was opened. The buffer stays as is;
 * the person picks reload, overwrite, or keep editing for now.
 */
export async function resolveNoteConflict(dialog: DialogApi, error: NoteConflictError): Promise<NoteConflictChoice> {
  const editor = error.current?.updatedBy.username
    ? `@${error.current.updatedBy.username}`
    : error.current?.updatedBy.displayName ?? "a teammate";
  const choice = await dialog.prompt<string>({
    closeOnClickOutside: false,
    content: (context: PromptContext<string>) => (
      <ChoiceDialog
        {...context}
        title={`Edited by ${editor} since you opened it`}
        choices={[
          { id: "reload", label: "Reload their version", description: "Your changes are dropped." },
          { id: "overwrite", label: "Overwrite with mine", description: "Their changes are dropped." },
          { id: "keep", label: "Keep editing", description: "Decide on the next save." },
        ]}
        selectedChoiceId="keep"
      />
    ),
  }).catch(() => undefined);
  return choice === "reload" || choice === "overwrite" ? choice : "keep";
}

export function ReadOnlyBanner({ owner, teams }: { owner: NoteOwner; teams: readonly TeamSummary[] }) {
  return (
    <Box height={1} paddingLeft={1}>
      <Text fg={colors.warning}>
        {owner.kind === "user"
          ? "Offline: notes are read-only until Gloom Cloud is reachable."
          : `Offline: ${ownerLabel(owner, teams)} notes are read-only.`}
      </Text>
    </Box>
  );
}
