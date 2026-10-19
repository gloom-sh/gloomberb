import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { apiClient, type TeamSummary, type TeamView } from "../../../../api-client";
import { teamStore } from "../../../../team/store";
import { teamViewsStore } from "./views";

function view(teamId: string): TeamView {
  return {
    id: `view-${teamId}`,
    teamId,
    name: `Movers ${teamId}`,
    revision: 1,
    spec: {},
    createdBy: "me",
    author: { username: "ada", displayName: "Ada" },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    publishedAt: "2026-10-01T00:00:00.000Z",
  };
}

afterEach(() => {
  teamViewsStore.dispose();
  mock.restore();
});

test("a team whose view list fails keeps its views and is asked again", async () => {
  teamViewsStore.attach({ registerPaneTemplate: () => () => {} });
  let teams = ["a", "b"];
  const snapshot = teamStore.getSnapshot();
  spyOn(teamStore, "getSnapshot").mockImplementation(() => ({
    ...snapshot,
    teams: teams.map((id) => ({ id }) as TeamSummary),
  }));
  spyOn(apiClient, "isVerified").mockReturnValue(true);
  const offline = new Set<string>();
  const listed: string[] = [];
  spyOn(apiClient, "listTeamViews").mockImplementation(async (teamId: string) => {
    listed.push(teamId);
    if (offline.has(teamId)) throw new Error("offline");
    return [view(teamId)];
  });

  await teamViewsStore.refresh();
  expect(teamViewsStore.list().map((entry) => entry.id)).toEqual(["view-a", "view-b"]);

  // Joining a third team refetches every list; team b's request fails this time.
  teams = ["a", "b", "c"];
  offline.add("b");
  await teamViewsStore.refresh();
  expect(teamViewsStore.list().map((entry) => entry.id)).toEqual(["view-a", "view-b", "view-c"]);

  offline.clear();
  listed.length = 0;
  await teamViewsStore.refresh();
  expect(listed).toContain("b");
});
