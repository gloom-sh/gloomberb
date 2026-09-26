import { describe, expect, test } from "bun:test";
import type { TeamMember, TeamSummary } from "../../../../api-client";
import {
  cycleAccent,
  draftChanges,
  draftFromTeam,
  draftProblem,
  emptyTeamDraft,
  nextFieldId,
  nextNonTextFieldId,
  restingFieldId,
  sectionFieldIds,
  setDraftName,
  setDraftShortName,
} from "./pane-model";

const team: TeamSummary = {
  id: "org-1",
  name: "Macro Desk",
  slug: "macro-desk",
  accentColor: "magenta",
  shortName: "MD",
  allowMemberInvites: false,
  channelId: "team:org-1",
  createdAt: "2026-09-14T12:00:00.000Z",
  role: "owner",
  memberCount: 3,
};

const members: TeamMember[] = [
  { id: "m-1", role: "owner", joinedAt: "", user: { id: "u0", username: "ada", displayName: "Ada" } },
  { id: "m-2", role: "admin", joinedAt: "", user: { id: "u2", username: "alice", displayName: "Alice" } },
  { id: "m-3", role: "member", joinedAt: "", user: { id: "u3", username: "bob", displayName: "Bob" } },
];

describe("team draft", () => {
  test("the short name follows the name until edited by hand", () => {
    let draft = emptyTeamDraft(0);
    draft = setDraftName(draft, "Rates Desk");
    expect(draft.shortName).toBe("RD");
    draft = setDraftName(draft, "Options");
    expect(draft.shortName).toBe("OPT");
    draft = setDraftShortName(draft, "op-x!");
    expect(draft.shortName).toBe("OPX");
    draft = setDraftName(draft, "Something Else");
    expect(draft.shortName).toBe("OPX");
    draft = setDraftShortName(draft, "");
    draft = setDraftName(draft, "Back To Auto");
    expect(draft.shortName).toBe("BTA");
  });

  test("problems and changes", () => {
    expect(draftProblem(emptyTeamDraft(0))).toBe("Give the team a name.");
    const draft = draftFromTeam(team);
    expect(draftProblem(draft)).toBeNull();
    expect(draftChanges(team, draft)).toEqual({});
    expect(draftChanges(team, { ...draft, name: "Macro Desk ", accentColor: "blue" })).toEqual({ accentColor: "blue" });
    expect(draftChanges(team, { ...draft, allowMemberInvites: true, shortName: "MX" })).toEqual({
      allowMemberInvites: true,
      shortName: "MX",
    });
  });

  test("accent cycles around the palette", () => {
    expect(cycleAccent("amber", -1)).toBe("violet");
    expect(cycleAccent("violet", 1)).toBe("amber");
    expect(cycleAccent("blue", 1)).toBe("cyan");
  });
});

describe("keyboard ring", () => {
  const base = { team, members, invitationIds: ["inv-1"], linkTokens: ["tok"], channelIds: ["team:org-1", "team:org-1:trades"], selfUserId: "u0" };

  test("owners reach every control; members only what they may use", () => {
    expect(sectionFieldIds({ ...base, section: "members" })).toEqual(["role:m-2", "remove:m-2", "role:m-3", "remove:m-3"]);
    expect(sectionFieldIds({ ...base, section: "invites" })).toEqual([
      "invite-username", "invite-send", "cancel-invitation:inv-1", "new-link", "copy-link:tok", "revoke-link:tok",
    ]);
    expect(sectionFieldIds({ ...base, section: "channels" })).toEqual([
      "open-channel:team:org-1", "open-channel:team:org-1:trades", "delete-channel:team:org-1:trades", "channel-name", "channel-create",
    ]);
    expect(sectionFieldIds({ ...base, section: "settings" })).toEqual(["name", "shortName", "accent", "allowMemberInvites", "save", "delete"]);

    const member = { ...base, team: { ...team, role: "member" as const } };
    expect(sectionFieldIds({ ...member, section: "members" })).toEqual([]);
    expect(sectionFieldIds({ ...member, section: "invites" })).toEqual([]);
    expect(sectionFieldIds({ ...member, team: { ...member.team, allowMemberInvites: true }, section: "invites" })).toEqual([
      "new-link", "copy-link:tok", "revoke-link:tok",
    ]);
    expect(sectionFieldIds({ ...member, section: "settings" })).toEqual(["leave"]);
    expect(sectionFieldIds({ ...base, section: "create", team: null })).toEqual(["name", "shortName", "accent", "create"]);
  });

  test("an invitation's answers lead the ring, which never rests in a text field outside the create form", () => {
    const invited = sectionFieldIds({ ...base, section: "create", team: null, receivedInvitationIds: ["inv-9"] });
    expect(invited.slice(0, 3)).toEqual(["accept:inv-9", "decline:inv-9", "name"]);
    expect(restingFieldId(invited, true)).toBe("accept:inv-9");
    expect(restingFieldId(sectionFieldIds({ ...base, section: "create", team: null }), true)).toBe("name");
    expect(restingFieldId(sectionFieldIds({ ...base, section: "invites" }), false)).toBeNull();
    expect(restingFieldId(sectionFieldIds({ ...base, section: "members" }), false)).toBe("role:m-2");
    const settings = sectionFieldIds({ ...base, section: "settings" });
    expect(nextNonTextFieldId(settings, "name")).toBe("accent");
    expect(nextNonTextFieldId(settings, "shortName")).toBe("accent");
  });

  test("walks the ring in both directions and wraps", () => {
    const ids = ["a", "b", "c"];
    expect(nextFieldId(ids, null, 1)).toBe("a");
    expect(nextFieldId(ids, null, -1)).toBe("c");
    expect(nextFieldId(ids, "c", 1)).toBe("a");
    expect(nextFieldId(ids, "a", -1)).toBe("c");
    expect(nextFieldId([], "a", 1)).toBeNull();
  });
});
