import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useReducer } from "react";
import { apiClient } from "../../../api-client";
import type { AuthUser, BuildoutAccountResponse } from "../../../api-client/types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { getBuildoutProToken } from "./model";
import { BuildoutPane } from "./pane";

const tui = createOpenTuiTestHarness({ width: 110, height: 22 });
const account = { subscription: { active: true } } as BuildoutAccountResponse;
const user = { id: "fixture-user" } as AuthUser;
let failedRead: "session" | "subscription" | "token" | null = null;
let dataRequests: string[] = [];
let signedIn: ReturnType<typeof spyOn<typeof apiClient, "isSignedIn">>;
let session: ReturnType<typeof spyOn<typeof apiClient, "getSession">>;
let subscription: ReturnType<typeof spyOn<typeof apiClient, "getBuildoutAccount">>;
let token: ReturnType<typeof spyOn<typeof apiClient, "getBuildoutToken">>;
beforeEach(() => {
  failedRead = null;
  dataRequests = [];
  signedIn = spyOn(apiClient, "isSignedIn").mockReturnValue(true);
  session = spyOn(apiClient, "getSession").mockImplementation(async () => {
    if (failedRead === "session") throw new Error("private session details");
    return user;
  });
  subscription = spyOn(apiClient, "getBuildoutAccount").mockImplementation(async () => {
    if (failedRead === "subscription") throw new Error("private subscription details");
    return account;
  });
  token = spyOn(apiClient, "getBuildoutToken").mockImplementation(async () => {
    if (failedRead === "token") throw new Error("private token details");
    return { token: "fixture-token", expiresAt: "2026-10-21T00:00:00Z" };
  });
  setHttpFetchTransport(async (input) => {
    const path = new URL(String(input)).pathname;
    dataRequests.push(path);
    return Response.json(path === "/companies"
      ? [{ id: "fixture-company", name: "Retained company" }]
      : []);
  });
});
afterEach(() => {
  signedIn.mockRestore(); session.mockRestore(); subscription.mockRestore(); token.mockRestore();
  setHttpFetchTransport(null);
});

async function mount() {
  const id = "buildout:access-test";
  const initial = createInitialState(createTestPaneConfig(`${process.env.HOME}/.cache/gloom-smoke/buildout-access-test`, {
    paneId: "buildout", instanceId: id,
  }));
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [state, dispatch] = useReducer(appReducer, initial);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId={id} pluginId="buildout" runtime={runtime} width={110} height={22} footerKeys>
      {(body) => <BuildoutPane paneId={id} paneType="buildout" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />); });
}

for (const read of ["session", "subscription", "token"] as const) {
  test(`${read} access failure keeps the loaded company list and never requests free data`, async () => {
    await mount();
    await tui.waitForFrameToContain("All Companies");
    await tui.emitKeypress({ name: "return" });
    await tui.waitForFrameToContain("Retained company");
    const requestsBefore = [...dataRequests];
    failedRead = read;
    await tui.emitKeypress({ name: "r" });
    const frame = await tui.waitForFrameToContain("Access check failed");
    expect(frame).toContain("Access is unknown");
    expect(frame).toContain("Retained company");
    expect(frame).not.toContain("upgrade");
    expect(frame).not.toContain("private");
    expect(dataRequests).toEqual(requestsBefore);
    failedRead = null;
    await tui.emitKeypress({ name: "r" });
    await tui.waitForFrameToExclude("Access check failed");
    await tui.waitForFrameToContain("All Companies");
    expect(dataRequests.length).toBeGreaterThan(requestsBefore.length);
  });
}

test("initial access failure has a retry that recovers without loading free data", async () => {
  failedRead = "session";
  await mount();
  await tui.waitForFrameToContain("Access is unknown");
  expect(dataRequests).toEqual([]);
  failedRead = null;
  await tui.clickFrameText("Retry");
  await tui.waitForFrameToContain("All Companies");
  expect(dataRequests).toContain("/lists");
});

test("confirmed sign-out and inactive subscriptions retain free access; active plans retain the token", async () => {
  signedIn.mockReturnValue(false);
  expect(await getBuildoutProToken()).toBeNull();
  expect(session).not.toHaveBeenCalled();
  signedIn.mockReturnValue(true);
  session.mockResolvedValueOnce(null);
  expect(await getBuildoutProToken()).toBeNull();
  expect(subscription).not.toHaveBeenCalled();
  subscription.mockResolvedValueOnce({ ...account, subscription: { ...account.subscription, active: false } });
  expect(await getBuildoutProToken()).toBeNull();
  expect(token).not.toHaveBeenCalled();
  expect(await getBuildoutProToken()).toBe("fixture-token");
});

test("a star that does not take is said on its row and in full in its detail, not in the footer", async () => {
  setHttpFetchTransport(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") return new Response("Starring is paused for maintenance.", { status: 503 });
    return Response.json(path === "/companies" ? [{ id: "fixture-company", name: "Retained company" }] : []);
  });
  await mount();
  await tui.waitForFrameToContain("All Companies");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Retained company");
  await tui.emitKeypress({ name: "s" });
  const row = (await tui.waitForFrameToContain(" ! ")).split("\n").find((line) => line.includes("Retained company"));
  expect(row).toContain("!");
  expect(tui.frame()).not.toContain("favorite failed");
  expect(tui.frame()).not.toContain("Starring is paused");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToContain("Could not star Retained company: Starring is paused for maintenance.");
});
