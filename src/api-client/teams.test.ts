import { afterEach, describe, expect, test } from "bun:test";
import type { AuthUser, TeamNotification } from "./index";
import { apiClient, setCloudApiFetchTransport } from "./index";

const originalWebSocket = globalThis.WebSocket;

const verifiedUser: AuthUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  username: "test",
  emailVerified: true,
  image: null,
  createdAt: "2026-03-30T00:00:00.000Z",
  updatedAt: "2026-03-30T00:00:00.000Z",
};

function createResponse(body: unknown): Response {
  const headers = {
    getSetCookie: () => [],
    get: () => null,
  } as unknown as Headers;

  return {
    ok: true,
    status: 200,
    headers,
    text: async () => JSON.stringify(body),
  } as Response;
}

interface RecordedRequest {
  path: string;
  search: string;
  method: string;
  body: unknown;
}

function recordRequests(
  respond: (request: RecordedRequest) => unknown,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  setCloudApiFetchTransport(async (url, init) => {
    const parsed = new URL(url);
    const request: RecordedRequest = {
      path: parsed.pathname,
      search: parsed.search,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    requests.push(request);
    return createResponse(respond(request));
  });
  return requests;
}

class TestWebSocket {
  static readonly OPEN = 1;
  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.onopen?.({});
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function installTestWebSocket(): TestWebSocket[] {
  const sockets: TestWebSocket[] = [];

  class InstalledTestWebSocket extends TestWebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }

  globalThis.WebSocket = InstalledTestWebSocket as unknown as typeof WebSocket;
  return sockets;
}

afterEach(() => {
  apiClient.dispose();
  globalThis.WebSocket = originalWebSocket;
  setCloudApiFetchTransport(null);
  apiClient.setSessionToken(null);
  apiClient.setWebSocketToken(null);
  apiClient.setCookieSessionMode(false);
});

describe("apiClient teams", () => {
  test("unwraps the team list and posts created teams", async () => {
    const team = {
      id: "team-1",
      name: "Research Desk",
      slug: "research-desk",
      accentColor: "violet" as const,
      shortName: "RD",
      allowMemberInvites: true,
      channelId: "team-1-channel",
      createdAt: "2026-05-01T00:00:00.000Z",
      role: "owner" as const,
      memberCount: 1,
    };
    const requests = recordRequests((request) =>
      request.method === "POST" ? team : { teams: [team] },
    );

    await expect(apiClient.listTeams()).resolves.toEqual([team]);
    await expect(
      apiClient.createTeam({
        name: "Research Desk",
        accentColor: "violet",
        shortName: "RD",
      }),
    ).resolves.toEqual(team);

    expect(requests).toEqual([
      { path: "/teams", search: "", method: "GET", body: null },
      {
        path: "/teams",
        search: "",
        method: "POST",
        body: { name: "Research Desk", accentColor: "violet", shortName: "RD" },
      },
    ]);
  });

  test("manages a team through /teams routes, never the auth plugin directly", async () => {
    const requests = recordRequests(({ path }) => {
      if (path.endsWith("/members/m-2")) return { members: [{ id: "m-2", role: "admin", joinedAt: "2026-05-01T00:00:00.000Z", user: { id: "u2", username: "alice", displayName: "Alice" } }] };
      if (path.endsWith("/invitations") && path.startsWith("/teams/team-1")) {
        return { invitations: [{ id: "inv-1", status: "pending", role: "member", expiresAt: "2026-05-08T00:00:00.000Z", createdAt: "2026-05-01T00:00:00.000Z", inviter: { id: "u1", username: "ada", displayName: "Ada" }, invitee: { id: "u3", username: "bob", displayName: "Bob" } }] };
      }
      if (path === "/teams/invitations") {
        return { invitations: [{ id: "inv-2", role: "member", expiresAt: "2026-05-08T00:00:00.000Z", createdAt: "2026-05-01T00:00:00.000Z", team: { id: "team-2", name: "Rates", slug: "rates", accentColor: "blue", shortName: "RT", memberCount: 4 }, inviter: { id: "u9", username: "ann", displayName: "Ann" } }] };
      }
      if (path.endsWith("/channels") && !path.includes("team:")) return { id: "team:team-1:trades", name: "trades", kind: "team", teamId: "team-1", created_at: "2026-05-01T00:00:00.000Z" };
      return { id: "team-1", name: "Macro Desk", role: "owner" };
    });

    await apiClient.updateTeam("team-1", { name: "Macro Desk", accentColor: "blue", allowMemberInvites: true });
    const members = await apiClient.updateTeamMemberRole("team-1", "m-2", "admin");
    await apiClient.removeTeamMember("team-1", "m-2");
    await apiClient.leaveTeam("team-1");
    await apiClient.deleteTeam("team-1");
    const sent = await apiClient.listTeamInvitations("team-1");
    const received = await apiClient.listMyTeamInvitations();
    await apiClient.acceptTeamInvitation("inv-2");
    await apiClient.rejectTeamInvitation("inv-2");
    await apiClient.cancelTeamInvitation("team-1", "inv-1");
    const channel = await apiClient.createTeamChannel("team-1", "Trades");
    await apiClient.deleteTeamChannel("team-1", "team:team-1:trades");

    expect(requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "PATCH /teams/team-1",
      "PATCH /teams/team-1/members/m-2",
      "DELETE /teams/team-1/members/m-2",
      "POST /teams/team-1/leave",
      "DELETE /teams/team-1",
      "GET /teams/team-1/invitations",
      "GET /teams/invitations",
      "POST /teams/invitations/inv-2/accept",
      "POST /teams/invitations/inv-2/reject",
      "DELETE /teams/team-1/invitations/inv-1",
      "POST /teams/team-1/channels",
      "DELETE /teams/team-1/channels/team%3Ateam-1%3Atrades",
    ]);
    expect(requests[0]?.body).toEqual({ name: "Macro Desk", accentColor: "blue", allowMemberInvites: true });
    expect(members[0]?.role).toBe("admin");
    expect(sent[0]?.invitee?.username).toBe("bob");
    expect(received[0]?.team.shortName).toBe("RT");
    expect(channel.id).toBe("team:team-1:trades");
    expect(requests.some((entry) => entry.path.startsWith("/auth/organization"))).toBe(false);
  });

  test("normalizes team notification timestamps", async () => {
    recordRequests(() => ({
      notifications: [
        {
          id: "n1",
          type: "team-invite",
          channelId: "team-1-channel",
          createdAt: "2026-05-01 07:30:00.000",
          data: {
            kind: "team-invite",
            team: {
              id: "team-1",
              name: "Research Desk",
              accentColor: "violet",
              shortName: "RD",
            },
            invitationId: "invitation-1",
            expiresAt: "2026-05-08T00:00:00.000Z",
            inviter: { id: "user-1", username: "ada", displayName: "Ada" },
          },
        },
      ],
    }));

    const notifications = await apiClient.getTeamNotifications();

    expect(notifications[0]?.createdAt).toBe("2026-05-01T07:30:00.000Z");
  });

  test("routes team notifications and cloud events to their subscribers", () => {
    const sockets = installTestWebSocket();
    apiClient.setSessionToken("session-token");
    apiClient.restoreCachedUser(verifiedUser);

    const seenNotifications: TeamNotification[] = [];
    const seenNotes: unknown[] = [];
    const unsubscribeNotifications = apiClient.subscribeTeamNotifications(
      (notification) => {
        seenNotifications.push(notification);
      },
    );
    const unsubscribeNotes = apiClient.subscribeCloudEvent(
      "note.updated",
      (data) => {
        seenNotes.push(data);
      },
    );

    const socket = sockets[0]!;
    socket.open();
    socket.receive({
      type: "team.notification",
      data: {
        id: "n1",
        type: "team-joined",
        channelId: "team-1-channel",
        createdAt: "2026-05-01 07:30:00.000",
        data: {
          kind: "team-joined",
          team: {
            id: "team-1",
            name: "Research Desk",
            accentColor: "violet",
            shortName: "RD",
          },
          member: { id: "user-2", username: "bob", displayName: "Bob" },
        },
      },
    });
    socket.receive({ type: "note.updated", data: { noteId: "note-1" } });
    socket.receive({ type: "chat.presence", onlineCount: 3 });

    expect(seenNotifications).toHaveLength(1);
    expect(seenNotifications[0]?.createdAt).toBe("2026-05-01T07:30:00.000Z");
    expect(seenNotes).toEqual([{ noteId: "note-1" }]);

    unsubscribeNotifications();
    unsubscribeNotes();
  });
});
