import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { apiClient, setCloudApiFetchTransport } from "../../../../api-client";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { createChatTestHarness } from "../../chat/test-harness";
import { TeamPane } from "./pane";
import { requestTeamPaneView } from "../../../../team/pane-request";
import { teamStore } from "../../../../team/store";
import { createTestTeam } from "../../../../team/test-fixture";

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
  if (path === "/teams/org-2/members") return { team: { ...macroDesk, id: "org-2" }, members: [] };
  if (path === "/teams/org-1/members/m-3" && method === "DELETE") return { members: members.filter((member) => member.id !== "m-3") };
  if (path === "/teams/org-1/members/m-2" && method === "PATCH") return { members: members.map((member) => (member.id === "m-2" ? { ...member, role: "member" } : member)) };
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
/** Paths, or "METHOD path"s, that answer 503, as an outage would. */
let failing = new Set<string>();

/** The pane's footer: its last line. */
const footer = (frame: string) => frame.trimEnd().split("\n").at(-1) ?? "";
const rowOf = (frame: string, text: string) => frame.split("\n").find((line) => line.includes(text)) ?? "";

/** Clicks `label` on the line holding `row`; `last` takes its last match on that line (a confirm's answer after its question). */
async function clickInRow(row: string, label: string, last = false) {
  const lines = tui.frame().split("\n");
  const y = lines.findIndex((line) => line.includes(row));
  const line = lines[y] ?? "";
  const x = last ? line.lastIndexOf(label) : line.indexOf(label, line.indexOf(row) + row.length);
  if (y < 0 || x < 0) throw new Error(`No "${label}" on the line with "${row}".\n${tui.frame()}`);
  await act(async () => {
    await tui.setup().mockMouse.click(x + 1, y);
    await tui.setup().renderOnce();
  });
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

const PANE_INSTANCE_ID = "team:test";
const toasts: string[] = [];
const paneRuntime = createTestPluginRuntime({ notify: (notification) => { toasts.push(notification.body ?? ""); } });

function Pane({ focused = true }: { focused?: boolean }) {
  // The open section is pane state, so the harness needs a real reducer.
  const [paneState, setPaneState] = useState<AppState["paneState"]>({});
  const state = createInitialState(createTestPaneConfig("/tmp/team-pane-test", {
    paneId: "team", instanceId: PANE_INSTANCE_ID,
  }));
  state.paneState = paneState;
  const dispatch = (action: AppAction) => setPaneState(appReducer(state, action).paneState);
  return (
    <TestPaneFrame
      state={state}
      dispatch={dispatch}
      paneId={PANE_INSTANCE_ID}
      pluginId="gloomberb-cloud"
      runtime={paneRuntime}
      width={100}
      height={25}
    >
      {(body) => <TeamPane paneId="team" paneType="team" focused={focused} {...body} />}
    </TestPaneFrame>
  );
}

beforeEach(() => {
  requests.length = 0;
  toasts.length = 0;
  receivedInvitations = [];
  failing = new Set();
  setCloudApiFetchTransport(async (url, init) => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${parsed.pathname}`);
    const down = failing.has(parsed.pathname) || failing.has(`${method} ${parsed.pathname}`);
    return new Response(JSON.stringify(down ? { error: "Service unavailable" } : respond(parsed.pathname, method)), {
      status: down ? 503 : 200,
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
  setCloudApiFetchTransport(null);
});

describe("TeamPane", () => {
  test("loads and lists the team's members", async () => {
    await act(async () => {
      await tui.render(<Pane />, { width: 100, height: 25 });
    });
    const frame = await tui.waitForFrameToContain("@alice");
    expect(frame).not.toContain("Members (3)");
    expect(frame).toContain("@ada");
    expect(frame).toContain("@alice");
    expect(requests).toContain("GET /teams/org-1/members");
  });

  test("switches sections on request: invites list pending people and links, never emails", async () => {
    await act(async () => {
      await tui.render(<Pane />, { width: 100, height: 25 });
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

  test("invitations or invite links that fail to load say so instead of listing none", async () => {
    failing = new Set(["/teams/org-1/invitations", "/teams/org-1/invite-links"]);
    await act(async () => {
      await tui.render(<Pane />, { width: 100, height: 25 });
    });
    await flush();
    await act(async () => {
      requestTeamPaneView({ teamId: "org-1", section: "invites" });
    });
    await tui.waitForFrameToContain("Service unavailable");
    await flush();
    // The New link button stays: making a link may work while listing them failed.
    const frame = await tui.waitForFrameToContain("New link");
    expect(frame.match(/Service unavailable/g)).toHaveLength(2);
    expect(frame).not.toContain("none pending");
    expect(frame).not.toContain("of 10 active");
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
      await tui.render(<Pane />, { width: 100, height: 25 });
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

  test("an action on a member, invitation, link or channel that fails is said on its row, the reason under it while its controls are chosen, not in the footer or a toast", async () => {
    await act(async () => {
      await tui.render(<Pane />, { width: 100, height: 25 });
    });
    await tui.waitForFrameToContain("@bob");
    failing = new Set(["/teams/org-1/members/m-3"]);
    await clickInRow("@bob", "Remove");
    await tui.waitForFrameToContain("Remove @bob?");
    await clickInRow("Remove @bob?", "Remove", true);
    await flush();
    const frame = await tui.waitForFrameToContain("Remove failed");
    expect(rowOf(frame, "@bob")).toContain("Remove failed");
    // Its reason, under the row while its Remove holds the ring; the footer stays clear.
    const lines = frame.split("\n");
    expect(lines[lines.findIndex((line) => line.includes("@bob")) + 1]).toContain("Service unavailable");
    expect(footer(frame)).not.toContain("Service unavailable");
    expect(toasts).toEqual([]);

    // Another member's control takes the reason away; the row keeps its state.
    await clickInRow("@alice", "Make member");
    await flush();
    expect(tui.frame()).not.toContain("Service unavailable");
    expect(rowOf(tui.frame(), "@bob")).toContain("Remove failed");

    // A removal that works takes the row away, which only a toast can say.
    failing = new Set();
    await clickInRow("@bob", "Remove", true);
    await tui.waitForFrameToContain("Remove @bob?");
    await clickInRow("Remove @bob?", "Remove", true);
    await flush();
    expect(toasts).toEqual(["Removed @bob."]);
    expect(footer(tui.frame())).not.toContain("Removed");
  });

  test("a canceled invitation or an invite that fails says so on its row or under its Send, not in the footer or a toast", async () => {
    await act(async () => {
      await tui.render(<Pane />, { width: 100, height: 25 });
    });
    await flush();
    await act(async () => {
      requestTeamPaneView({ teamId: "org-1", section: "invites" });
    });
    await tui.waitForFrameToContain("@carol");
    failing = new Set(["/teams/org-1/invitations/inv-1", "POST /teams/org-1/invitations"]);
    await clickInRow("@carol", "Cancel");
    await flush();
    let frame = await tui.waitForFrameToContain("Cancel failed");
    expect(rowOf(frame, "@carol")).toContain("Cancel failed");

    await tui.clickFrameText("@analyst");
    await act(async () => {
      await tui.setup().mockInput.typeText("dave");
    });
    await tui.waitForFrameToContain("dave");
    await clickInRow("dave", "Send");
    await flush();
    frame = await tui.waitForFrameToContain("Service unavailable");
    const lines = frame.split("\n");
    expect(lines[lines.findIndex((line) => line.includes("dave")) + 1]).toContain("Service unavailable");
    expect(footer(frame)).not.toContain("Service unavailable");
    expect(toasts).toEqual([]);
  });
});
