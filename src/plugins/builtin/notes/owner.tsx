import { useSyncExternalStore } from "react";
import type { TeamSummary } from "../../../api-client";
import { choiceDialog } from "../../../components/ui/choice-dialog";
import { Notice } from "../../../components/ui/status";
import { QueryBar } from "../../../components/ui/query-bar";
import { Box } from "../../../ui";
import type { DialogApi } from "../../../ui/dialog";
import { colors } from "../../../theme/colors";
import { canManageTeam, teamAccentHex, teamPrefix } from "../../../team/model";
import { teamStore } from "../../../team/store";
import { NoteConflictError, type NoteOwner, noteOwnerKey } from "./store";

export function useNoteTeams(): TeamSummary[] {
  return useSyncExternalStore(
    (onChange) => teamStore.subscribe(onChange),
    () => teamStore.getSnapshot(),
  ).teams;
}

/**
 * Whether the server lets me delete a note: any of mine, and a team note I
 * wrote or whose team I run. A team note without an author is one I just
 * added, or one from a server that lets any member delete.
 */
export function mayDeleteNote(
  note: { owner: NoteOwner; createdBy?: string | null },
  teams: readonly TeamSummary[],
  selfUserId: string | null,
): boolean {
  const { owner } = note;
  if (owner.kind === "user" || note.createdBy === undefined) return true;
  if (selfUserId !== null && note.createdBy === selfUserId) return true;
  return canManageTeam(teams.find((team) => team.id === owner.teamId)?.role);
}

/** Why a teammate's note offers no delete. */
export const NOT_YOUR_NOTE = "Only its author or a team admin can delete this note.";

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
  const choice = await choiceDialog(dialog, {
    title: "New note for",
    choices: [
      { id: "user", label: "Me", description: "Only you see it." },
      ...teams.map((team) => ({ id: `team:${team.id}`, label: `${teamPrefix(team)} ${team.name}`, description: "Every member can read and edit it." })),
    ],
    selectedChoiceId: noteOwnerKey(preferred),
    logSource: "notes.owner",
    logMessage: "The new note owner prompt failed",
  });
  if (!choice) return null;
  return choice === "user" ? { kind: "user" } : { kind: "team", teamId: choice.slice("team:".length) };
}

type NoteConflictChoice = "reload" | "overwrite" | "keep";

/**
 * A teammate saved since this note was opened. The buffer stays as is;
 * the person picks reload, overwrite, or keep editing for now.
 */
async function resolveNoteConflict(dialog: DialogApi, error: NoteConflictError): Promise<NoteConflictChoice> {
  const editor = error.current?.updatedBy.username
    ? `@${error.current.updatedBy.username}`
    : error.current?.updatedBy.displayName ?? "a teammate";
  const choice = await choiceDialog(dialog, {
    closeOnClickOutside: false,
    title: `Edited by ${editor} since you opened it`,
    choices: [
      { id: "reload", label: "Reload their version", description: "Your changes are dropped." },
      { id: "overwrite", label: "Overwrite with mine", description: "Their changes are dropped." },
      { id: "keep", label: "Keep editing", description: "Decide on the next save." },
    ],
    selectedChoiceId: "keep",
    logSource: "notes.owner",
    logMessage: "The note conflict prompt failed",
  });
  return choice === "reload" || choice === "overwrite" ? choice : "keep";
}

export async function handleNoteSaveError(
  error: unknown,
  options: {
    dialog: DialogApi;
    cacheKey: string;
    text: string;
    lastSaved: Map<string, string>;
    acceptCurrent: (current: NonNullable<NoteConflictError["current"]>) => void;
    onReload: (theirs: string) => void;
    save: () => Promise<void>;
    notify: (notification: { body: string; type: "error" }) => void;
    onOtherError: (error: unknown) => void;
  },
): Promise<void> {
  if (!(error instanceof NoteConflictError)) {
    options.onOtherError(error);
    return;
  }
  options.lastSaved.delete(options.cacheKey);
  const choice = await resolveNoteConflict(options.dialog, error);
  if (choice === "reload") {
    const theirs = error.current?.content ?? "";
    if (error.current) options.acceptCurrent(error.current);
    options.lastSaved.set(options.cacheKey, theirs);
    options.onReload(theirs);
  } else if (choice === "overwrite") {
    if (error.current) options.acceptCurrent(error.current);
    options.lastSaved.set(options.cacheKey, options.text);
    await options.save().catch((again: unknown) => {
      options.notify({ body: again instanceof Error ? again.message : "Could not save the note.", type: "error" });
    });
  }
}

export function ReadOnlyBanner({ owner, teams }: { owner: NoteOwner; teams: readonly TeamSummary[] }) {
  return (
    <Box paddingLeft={1}>
      <Notice>
        {owner.kind === "user"
          ? "Offline: notes are read-only until Gloom Cloud is reachable."
          : `Offline: ${ownerLabel(owner, teams)} notes are read-only.`}
      </Notice>
    </Box>
  );
}
