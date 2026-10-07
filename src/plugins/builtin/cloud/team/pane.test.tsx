import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../../api-client";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createChatTestHarness } from "../../chat/test-harness";
import { TeamPane } from "./pane";
import { requestTeamPaneView } from "./pane-request";
import { teamStore } from "./store";
import { createTestTeam } from "./test-fixture";

// The pane hosts team chat, so it needs the chat API defaults and cleanup too.
const tui = createChatTestHarness();

const macroDesk = createTestTeam({ role: "owner" });

const members = [
  { id: "m-1", role: "owner", joinedAt: "2026-09-01T00:00:00.000Z", user: { id: "u0", username: "ada", displayName: "Ada" } },
  { id: "m-2", role: "admin", joinedAt: "2026-09-02T00:00:00.000Z", user: { id: "u2", username: "alice", displayName: "Alice Byrne" } },
  { id: "m-3", role: "member", joinedAt: "2026-09-03T00:00:00.000Z", user: { id: "u3", username: "bob", displayName: "Bob" } },
];

function respond(path: string, method: string): unknown {
  if (path === "/teams/org-1/members") return { team: macroDesk, members };
  if (path === "/teams/org-1/invitations" && method === "GET") {
    return { invitations: [{ id: "inv-1", status: "pending", role: "member", expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), createdAt: "2026-09-14T00:00:00.000Z", inviter: members[0]!.user, invitee: { id: "u9", username: "carol", displayName: "Carol" } }] };
  }
  if (path === "/teams/org-1/invite-links") return { links: [{ token: "a".repeat(32), url: "https://gloom.sh/teams/invite/aaaaaaaa", teamId: "org-1", createdBy: "u0", expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), maxUses: null, uses: 3, createdAt: "2026-09-14T00:00:00.000Z" }] };
  if (path === "/teams") return { teams: [macroDesk] };
  if (path === "/teams/invitations") return { invitations: receivedInvitations };
  if (path === "/teams/invitations/inv-9/accept") return { ...macroDesk, id: "org-2", name: "Rates Desk", shortName: "RD", channelId: "team:org-2", role: "member" };
  if (path === "/teams/notifications") return { notifications: [] };
  if (path === "/chat/channels") return [];
  if (path === "/chat/state") return { channels: [], onlineCount: 0, channelStates: [], notifications: [] };
  if (path.endsWith("/views") || path.endsWith("/collections")) return { items: [] };
  return {};
}

const requests: string[] = [];
let receivedInvitations: unknown[] = [];

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

const PANE_INSTANCE_ID = "team:test";
const paneRuntime = createTestPluginRuntime();

function Pane({ focused = true }: { focused?: boolean }) {
  // The open section is pane state, so the harness needs a real reducer.
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = createInitialState(createTestPaneConfig("/tmp/team-pane-test", {
    paneId: "team", instanceId: PANE_INSTANCE_ID,
  }));
  state.paneState = paneState;
  const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
  return (
    <TestPaneProvider
      state={state}
      dispatch={dispatch}
      paneId={PANE_INSTANCE_ID}
      pluginId="gloomberb-cloud"
      runtime={paneRuntime}
    >
      <TeamPane paneId="team" paneType="team" focused={focused} width={84} height={24} />
    </TestPaneProvider>
  );
}

beforeEach(() => {
  requests.length = 0;
  receivedInvitations = [];
  setCloudApiFetchTransport(async (url, init) => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${parsed.pathname}`);
    return new Response(JSON.stringify(respond(parsed.pathname, method)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  apiClient.setSessionToken("team-pane-session");
  apiClient.restoreCachedUser({ id: "u0", username: "ada", emailVerified: true, plan: "pro" });
  (teamStore as any).update({ teams: [macroDesk], invitations: [], loaded: true });
});

afterEach(() => {
  (teamStore as any).update({ teams: [], invitations: [], loaded: false });
  apiClient.setSessionToken(null);
});

describe("TeamPane", () => {
  test("loads and lists the team's members", async () => {
    await act(async () => {
      await tui.render(<Pane />, { width: 84, height: 24 });
    });
    const frame = await tui.waitForFrameToContain("@alice");
    expect(frame).not.toContain("Members (3)");
    expect(frame).toContain("@ada");
    expect(frame).toContain("@alice");
    expect(requests).toContain("GET /teams/org-1/members");
  });

  test("switches sections on request: invites list pending people and links, never emails", async () => {
    await act(async () => {
      await tui.render(<Pane />, { width: 84, height: 24 });
    });
    await flush();
    await act(async () => {
      requestTeamPaneView({ teamId: "org-1", section: "invites" });
    });
    await tui.waitForFrameToContain("@carol");
    const frame = await tui.waitForFrameToContain("3 uses");
    expect(frame).toContain("Invite by Username");
    expect(frame).toContain("@carol");
    expect(frame).toContain("gloom.sh/teams/invite/aaaaaaaa");
    expect(frame).toContain("3 uses");
    expect(frame).not.toContain("@example.com");
  });

  test("shows a banner for an invitation addressed to me", async () => {
    receivedInvitations = [{
      id: "inv-9",
      role: "member",
      expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      createdAt: "2026-09-14T00:00:00.000Z",
      team: { id: "org-2", name: "Rates Desk", slug: "rates", accentColor: "blue", shortName: "RD", memberCount: 4 },
      inviter: { id: "u5", username: "ann", displayName: "Ann" },
    }];
    (teamStore as any).update({ teams: [macroDesk], invitations: receivedInvitations, loaded: true });
    await act(async () => {
      await tui.render(<Pane />, { width: 84, height: 24 });
    });
    const frame = await tui.waitForFrameToContain("@ann invited you");
    expect(frame).toContain("RD· Rates Desk");
    expect(frame).toContain("@ann invited you");
    expect(frame).toContain("Accept");
    expect(frame).toContain("Decline");

    // The keyboard lands on Accept, so joining needs no mouse.
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await flush();
    expect(requests).toContain("POST /teams/invitations/inv-9/accept");
  });
});
