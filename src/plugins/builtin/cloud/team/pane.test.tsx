import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../../api-client";
import { testRender } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../../state/app/context";
import { createTestPaneConfig, TestPaneProvider } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { cleanupChatTest, installChatApiTestDefaults } from "../../chat/test-harness";
import { TeamPane } from "./pane";
import { requestTeamPaneView } from "./pane-request";
import { teamStore } from "./store";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

const macroDesk = {
  id: "org-1",
  name: "Macro Desk",
  slug: "macro-desk",
  accentColor: "magenta" as const,
  shortName: "MD",
  allowMemberInvites: false,
  channelId: "team:org-1",
  createdAt: "2026-09-14T12:00:00.000Z",
  role: "owner" as const,
  memberCount: 3,
};

const members = [
  { id: "m-1", role: "owner", joinedAt: "2026-09-01T00:00:00.000Z", user: { id: "u0", username: "vince", displayName: "Vince" } },
  { id: "m-2", role: "admin", joinedAt: "2026-09-02T00:00:00.000Z", user: { id: "u2", username: "lucas", displayName: "Lucas Bing" } },
  { id: "m-3", role: "member", joinedAt: "2026-09-03T00:00:00.000Z", user: { id: "u3", username: "mikahk", displayName: "Mika" } },
];

function respond(path: string, method: string): unknown {
  if (path === "/teams/org-1/members") return { team: macroDesk, members };
  if (path === "/teams/org-1/invitations" && method === "GET") {
    return { invitations: [{ id: "inv-1", status: "pending", role: "member", expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), createdAt: "2026-09-14T00:00:00.000Z", inviter: members[0]!.user, invitee: { id: "u9", username: "sneh", displayName: "Sneh" } }] };
  }
  if (path === "/teams/org-1/invite-links") return { links: [{ token: "a".repeat(32), url: "https://gloom.sh/teams/invite/aaaaaaaa", teamId: "org-1", createdBy: "u0", expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), maxUses: null, uses: 3, createdAt: "2026-09-14T00:00:00.000Z" }] };
  if (path === "/teams") return { teams: teamsOnServer };
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
let teamsOnServer: unknown[] = [macroDesk];

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
  installChatApiTestDefaults();
  requests.length = 0;
  receivedInvitations = [];
  teamsOnServer = [macroDesk];
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
  apiClient.restoreCachedUser({ id: "u0", username: "vince", emailVerified: true, plan: "pro" });
  (teamStore as any).update({ teams: [macroDesk], invitations: [], loaded: true });
});

afterEach(async () => {
  await cleanupChatTest(setup);
  setup = undefined;
  (teamStore as any).update({ teams: [], invitations: [], loaded: false });
  apiClient.setSessionToken(null);
});

describe("TeamPane", () => {
  test("shows the team, its members with roles, and management actions for the owner", async () => {
    await act(async () => {
      setup = await testRender(<Pane />, { width: 84, height: 24 });
    });
    await flush();
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("MD· Macro Desk");
    expect(frame).toContain("Members");
    expect(frame).not.toContain("Members (3)");
    expect(frame).toContain("@vince");
    expect(frame).toContain("Owner");
    expect(frame).toContain("@lucas");
    expect(frame).toContain("Admin");
    expect(frame).toContain("Make member");
    expect(frame).toContain("Remove");
    expect(requests).toContain("GET /teams/org-1/members");
  });

  test("switches sections on request: invites list pending people and links, never emails", async () => {
    await act(async () => {
      setup = await testRender(<Pane />, { width: 84, height: 24 });
    });
    await flush();
    await act(async () => {
      requestTeamPaneView({ teamId: "org-1", section: "invites" });
    });
    await flush();
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("INVITE BY USERNAME");
    expect(frame).toContain("@sneh");
    expect(frame).toContain("gloom.sh/teams/invite/aaaaaaaa");
    expect(frame).toContain("3 uses");
    expect(frame).not.toContain("@example.com");
  });

  test("the create form previews the accent with the short name derived from the name", async () => {
    teamsOnServer = [];
    (teamStore as any).update({ teams: [], invitations: [], loaded: true });
    await act(async () => {
      setup = await testRender(<Pane />, { width: 84, height: 24 });
    });
    await flush();
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("New team");
    expect(frame).toContain("Create team");
    // The picker names the chosen accent and previews the prefix; the swatches
    // themselves are colored badges, which a char frame cannot show.
    expect(frame).toMatch(/Accent\s+\w+/);
    expect(frame).toContain("TM· Your team");
  });

  test("settings edit in place with a live accent preview; channels list with a creator", async () => {
    await act(async () => {
      setup = await testRender(<Pane />, { width: 84, height: 26 });
    });
    await flush();
    await act(async () => {
      requestTeamPaneView({ teamId: "org-1", section: "settings" });
    });
    await flush();
    let frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("Short name");
    expect(frame).toContain("MD· Macro Desk");
    expect(frame).toContain("Members can share invite links");
    expect(frame).toContain("Save changes");
    expect(frame).toContain("DELETE TEAM");

    await act(async () => {
      requestTeamPaneView({ teamId: "org-1", section: "channels" });
    });
    await flush();
    frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("NEW CHANNEL");
    expect(frame).toContain("earnings-season");
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
      setup = await testRender(<Pane />, { width: 84, height: 24 });
    });
    await flush();
    const frame = setup!.captureCharFrame();
    if (process.env.PRINT_FRAMES) console.log(frame);
    expect(frame).toContain("RD· Rates Desk");
    expect(frame).toContain("@ann invited you");
    expect(frame).toContain("Accept");
    expect(frame).toContain("Decline");

    // The keyboard lands on Accept, so joining needs no mouse.
    await act(async () => {
      setup!.renderer.keyInput.emit("keypress", {
        name: "return",
        sequence: "\r",
        ctrl: false,
        meta: false,
        option: false,
        shift: false,
        eventType: "press",
        repeated: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as any);
    });
    await flush();
    expect(requests).toContain("POST /teams/invitations/inv-9/accept");
  });
});
