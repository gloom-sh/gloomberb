import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { apiClient } from "../../../../api-client";
import { ApiRequestError } from "../../../../api-client/errors";
import type { WaitlistState } from "../../../../api-client/product-waitlist";
import { createOpenTuiTestHarness, TestDialogProvider } from "../../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../../test-support/pane";
import { createTestPluginRuntime } from "../../../../test-support/plugin-runtime";
import { PharmaSignalsResearchTab, PharmaWaitlistClientContext } from "./tab";
import type { WaitlistClient } from "./waitlist";

const PANE = "ticker-research:signals";
const tui = createOpenTuiTestHarness();

const NOT_YET = "Pharma signals are not available yet.";
const ON_LIST = "You're on the pharma signals waitlist.";
// The dialog wraps the line; its start is enough to know it is there.
const PRICE = "Planned price: $50/month on top of Pro";
const NO_CHARGE = "Nothing is charged now. No card needed.";
const VERIFY = "Verify your email to join the pharma signals waitlist.";
const RESEND = "Resend Verification Email";
// What the service answers every waitlist call of an unverified account.
const unverifiedRefusal = () => new ApiRequestError("Email verification required", 403);

// The session, switched by the test as a sign-in, a sign-out or another account would.
let account: string | null = null;
let verified = true;
const accountListeners = new Set<() => void>();
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  account = null;
  verified = true;
  spies.push(
    spyOn(apiClient, "getCurrentUser").mockImplementation(() => (
      account ? { id: account, emailVerified: verified, plan: "free" } as ReturnType<typeof apiClient.getCurrentUser> : null
    )),
    spyOn(apiClient, "subscribeCurrentUser").mockImplementation((listener: () => void) => {
      accountListeners.add(listener);
      return () => { accountListeners.delete(listener); };
    }),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  accountListeners.clear();
});

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  }
}

async function signInAs(id: string | null, emailVerified = true) {
  await act(async () => {
    account = id;
    verified = emailVerified;
    for (const listener of accountListeners) listener();
  });
  await settle();
}

const state = (joined: boolean): WaitlistState => ({
  product: "pharma-signals",
  joined,
  joinedAt: joined ? "2026-12-02T10:00:00.000Z" : null,
});

/** A client whose every call waits until the test answers it, keyed by the account it was sent as. */
function controlledClient() {
  type Call = { kind: "read" | "join" | "leave"; account: string | null } & PromiseWithResolvers<WaitlistState>;
  const calls: Call[] = [];
  const send = (kind: Call["kind"]) => {
    const call = { kind, account, ...Promise.withResolvers<WaitlistState>() };
    calls.push(call);
    return call.promise;
  };
  const client: WaitlistClient = {
    getWaitlist: () => send("read"),
    joinWaitlist: () => send("join"),
    leaveWaitlist: () => send("leave"),
  };
  const of = (kind: Call["kind"]) => calls.filter((call) => call.kind === kind);
  const answer = async (call: Call | undefined, value: WaitlistState | Error) => {
    if (!call) throw new Error("No such call");
    await act(async () => {
      if (value instanceof Error) call.reject(value);
      else call.resolve(value);
    });
    await settle();
  };
  return { client, calls, of, answer };
}

async function render(client: WaitlistClient, runtime = createTestPluginRuntime()) {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-signals-test", {
    instanceId: PANE, paneId: "ticker-detail", binding: { kind: "fixed", symbol: "VKTX" },
  }));
  initial.focusedPaneId = PANE;
  function Harness() {
    const [app, setApp] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setApp((current) => appReducer(current, action)), []);
    return (
      <TestDialogProvider>
        <TestPaneFrame state={app} dispatch={dispatch} paneId={PANE} pluginId="ticker-research" runtime={runtime} width={100} height={18} footerKeys>
          {(body) => (
            <PharmaWaitlistClientContext value={client}>
              <PharmaSignalsResearchTab focused onCapture={() => {}} {...body} />
            </PharmaWaitlistClientContext>
          )}
        </TestPaneFrame>
      </TestDialogProvider>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width: 100, height: 24 }); });
  await settle();
  return tui.frame();
}

async function press(name: string) {
  await tui.emitKeypress(name === "enter" ? { name: "return", sequence: "\r" } : { name, sequence: name });
  await settle();
  return tui.frame();
}

test("signed out, the button opens the sign-in and a sign-in joins no one", async () => {
  const waitlist = controlledClient();
  const commands: Array<string | undefined> = [];
  const frame = await render(waitlist.client, createTestPluginRuntime({ openCommandBar: (query) => { commands.push(query); } }));
  expect(frame).toContain(NOT_YET);
  expect(frame).toContain("Log in to join");
  expect(waitlist.calls).toHaveLength(0);

  await press("enter");
  expect(commands).toEqual(["Log In"]);
  expect(tui.frame()).not.toContain(PRICE);

  await signInAs("acct-a");
  expect(waitlist.of("read")).toHaveLength(1);
  await waitlist.answer(waitlist.of("read")[0], state(false));
  expect(tui.frame()).toContain("Join waitlist");
  expect(waitlist.of("join")).toHaveLength(0);
});

test("joining asks first: Enter answers Not now, y joins once, and leaving takes it back", async () => {
  account = "acct-a";
  const waitlist = controlledClient();
  await render(waitlist.client);
  expect(tui.frame()).not.toContain("Join waitlist");
  await waitlist.answer(waitlist.of("read")[0], state(false));

  let frame = await press("enter");
  expect(frame).toContain("Join the pharma signals waitlist");
  expect(frame).toContain(PRICE);
  expect(frame).toContain(NO_CHARGE);
  expect(frame).toContain("Not now");
  // A stray Enter is Not now.
  frame = await press("enter");
  expect(frame).not.toContain(PRICE);
  expect(waitlist.of("join")).toHaveLength(0);

  await press("enter");
  frame = await press("y");
  expect(frame).toContain("Joining…");
  // A second press while the join is out sends nothing more.
  await press("enter");
  expect(waitlist.of("join")).toHaveLength(1);
  await waitlist.answer(waitlist.of("join")[0], state(true));
  frame = tui.frame();
  expect(frame).toContain(ON_LIST);
  expect(frame).toContain("Leave waitlist");

  await press("enter");
  expect(waitlist.of("leave")).toHaveLength(1);
  await waitlist.answer(waitlist.of("leave")[0], state(false));
  expect(tui.frame()).toContain("Join waitlist");
});

test("another account never sees the last one's answers", async () => {
  account = "acct-a";
  const waitlist = controlledClient();
  await render(waitlist.client);
  const readA = waitlist.of("read")[0];

  await signInAs("acct-b");
  const readB = waitlist.of("read")[1];
  expect(readB?.account).toBe("acct-b");
  // A's answer lands after the switch: B's place is still unknown, not "on the list".
  await waitlist.answer(readA, state(true));
  expect(tui.frame()).not.toContain(ON_LIST);
  expect(tui.frame()).not.toContain("Join waitlist");
  await waitlist.answer(readB, state(false));
  expect(tui.frame()).toContain("Join waitlist");

  // B joins; the answer comes back once C holds the session.
  await press("enter");
  await press("y");
  const joinB = waitlist.of("join")[0];
  expect(joinB?.account).toBe("acct-b");
  await signInAs("acct-c");
  await waitlist.answer(joinB, state(true));
  expect(tui.frame()).not.toContain(ON_LIST);
  await waitlist.answer(waitlist.of("read")[2], state(false));
  expect(tui.frame()).toContain("Join waitlist");

  // Signed out, nothing of any account is left.
  await signInAs(null);
  expect(tui.frame()).toContain("Log in to join");
});

test("a sign-in to another account while the dialog is open sends nothing", async () => {
  account = "acct-a";
  const waitlist = controlledClient();
  await render(waitlist.client);
  await waitlist.answer(waitlist.of("read")[0], state(false));
  expect(await press("enter")).toContain(PRICE);

  await signInAs("acct-b");
  await press("y");
  expect(waitlist.of("join")).toHaveLength(0);
});

test("a read already out when a join began cannot put back the state from before it", async () => {
  account = "acct-a";
  const waitlist = controlledClient();
  await render(waitlist.client);
  await waitlist.answer(waitlist.of("read")[0], state(false));

  // `r` reads again; the answer is slow.
  await press("r");
  const slowRead = waitlist.of("read")[1];
  expect(slowRead).toBeDefined();
  await press("enter");
  await press("y");
  await waitlist.answer(waitlist.of("join")[0], state(true));
  expect(tui.frame()).toContain(ON_LIST);
  await waitlist.answer(slowRead, state(false));
  expect(tui.frame()).toContain(ON_LIST);
});

test("a join that fails says so and leaves the account off the list", async () => {
  account = "acct-a";
  const waitlist = controlledClient();
  const notices: Array<{ body: string; desktop?: string }> = [];
  await render(waitlist.client, createTestPluginRuntime({ notify: (notice) => { notices.push({ body: notice.body, desktop: notice.desktop }); } }));
  await waitlist.answer(waitlist.of("read")[0], state(false));
  await press("enter");
  await press("y");
  await waitlist.answer(waitlist.of("join")[0], new Error("Service unavailable"));
  expect(notices).toEqual([{ body: "Couldn't join the waitlist. Try again.", desktop: "never" }]);
  // The place is read again, so the button stands for what the server holds.
  await waitlist.answer(waitlist.of("read")[1], state(false));
  expect(tui.frame()).toContain("Join waitlist");
  expect(tui.frame()).not.toContain(ON_LIST);
});

test("an unverified address is asked to verify, sends nothing, and verifying reads its place", async () => {
  account = "acct-a";
  verified = false;
  const waitlist = controlledClient();
  const commands: Array<string | undefined> = [];
  const frame = await render(waitlist.client, createTestPluginRuntime({ openCommandBar: (query) => { commands.push(query); } }));
  expect(frame).toContain(VERIFY);
  expect(frame).toContain(RESEND);
  expect(frame).not.toContain("Join waitlist");
  expect(waitlist.calls).toHaveLength(0);

  // The button resends the verification email; it opens no join dialog.
  await press("enter");
  expect(commands).toEqual([RESEND]);
  expect(tui.frame()).not.toContain(PRICE);

  // Verified on the same account: its place is read, and joining still asks first.
  await signInAs("acct-a", true);
  expect(waitlist.of("read")).toHaveLength(1);
  await waitlist.answer(waitlist.of("read")[0], state(false));
  expect(tui.frame()).toContain("Join waitlist");
  expect(waitlist.of("join")).toHaveLength(0);
});

test("the service's verification refusal says to verify, never to try again", async () => {
  account = "acct-a";
  const waitlist = controlledClient();
  const notices: string[] = [];
  await render(waitlist.client, createTestPluginRuntime({ notify: (notice) => { notices.push(notice.body); } }));
  // The app thought the address verified; the read says otherwise.
  await waitlist.answer(waitlist.of("read")[0], unverifiedRefusal());
  let frame = tui.frame();
  expect(frame).toContain(VERIFY);
  expect(frame).toContain(RESEND);
  expect(frame).not.toContain("Retry");
  expect(frame).not.toContain("Email verification required");

  // Verified meanwhile: `r` reads again; then a join the service refuses says why.
  await press("r");
  await waitlist.answer(waitlist.of("read")[1], state(false));
  await press("enter");
  await press("y");
  await waitlist.answer(waitlist.of("join")[0], unverifiedRefusal());
  expect(notices).toEqual(["Verify your email to join the waitlist."]);
  frame = tui.frame();
  expect(frame).toContain(VERIFY);
  expect(frame).not.toContain(ON_LIST);
  // Nothing more is sent for an account the service will not answer.
  expect(waitlist.of("read")).toHaveLength(2);
});
