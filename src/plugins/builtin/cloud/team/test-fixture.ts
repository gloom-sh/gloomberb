import type { TeamSummary } from "../../../../api-client";

/** The "Macro Desk" team as a plain member sees it; override the role or counts a test is about. */
export function createTestTeam(overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: "org-1",
    name: "Macro Desk",
    slug: "macro-desk",
    accentColor: "magenta",
    shortName: "MD",
    allowMemberInvites: false,
    channelId: "team:org-1",
    createdAt: "2026-09-14T12:00:00.000Z",
    role: "member",
    memberCount: 3,
    ...overrides,
  };
}

/** The same team as notifications carry it. */
export function createTestTeamCard() {
  return { id: "org-1", name: "Macro Desk", accentColor: "magenta" as const, shortName: "MD" };
}
