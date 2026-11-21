import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient, type AccountProfile } from "../../../api-client";
import { AuthDialogHost, interceptAuthDialogForTests, type AuthDialogRequest } from "../../../account/auth-dialog";
import * as researchActivity from "../../../api-client/research-activity";
import { setCheckoutHandoffPollForTests } from "../../../account/checkout-handoff";
import { accountSession, registerAccountSession } from "../../../account/session";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { useRendererHost } from "../../../ui";
import { openCloudUpgradeUrl, resetCloudUpgradeGuardForTests, useCloudUpgradeAction } from "./cloud-upgrade";

const tui = createOpenTuiTestHarness();

const originalCreateCloudCheckout = apiClient.createCloudCheckout;
const originalCreateBrowserHandoff = apiClient.createBrowserHandoff;
const originalRecordResearchActivity = apiClient.recordResearchActivity;
const originalGetAccountProfile = apiClient.getAccountProfile;
let checkouts = 0;
let opened: string[] = [];

beforeEach(() => {
  checkouts = 0;
  opened = [];
  apiClient.recordResearchActivity = (async () => {}) as typeof apiClient.recordResearchActivity;
  apiClient.setSessionToken("cloud-upgrade-session");
  apiClient.restoreCachedUser({ id: "user-free", email: "free@example.com", emailVerified: true, plan: "free" });
});

afterEach(() => {
  apiClient.createCloudCheckout = originalCreateCloudCheckout;
  apiClient.createBrowserHandoff = originalCreateBrowserHandoff;
  apiClient.recordResearchActivity = originalRecordResearchActivity;
  apiClient.getAccountProfile = originalGetAccountProfile;
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  setSystemTime();
  resetCloudUpgradeGuardForTests();
});

function Prompt({ placement }: { placement: string }) {
  useCloudUpgradeAction(placement);
  return null;
}

/** Mounts onboarding's Pro step action, with the browser tabs it opens recorded. */
async function renderUpgradeAction(): Promise<(options?: unknown) => Promise<void>> {
  let upgrade!: (options?: unknown) => Promise<void>;
  function ProStep() {
    upgrade = useCloudUpgradeAction("onboarding-pro");
    useRendererHost().openExternal = async (url: string) => {
      opened.push(url);
    };
    return null;
  }
  await tui.render(<ProStep />);
  return upgrade;
}

test("a held Enter opens one checkout, and another only once a few seconds have passed", async () => {
  const created = Promise.withResolvers<{ url: string }>();
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    return created.promise;
  }) as typeof apiClient.createCloudCheckout;
  const upgrade = await renderUpgradeAction();
  let opening = 0;
  const press = () => upgrade({ sheet: false, onOpening: () => { opening += 1; } });

  const held = [press(), press(), press()];
  created.resolve({ url: "https://checkout.example/session" });
  await Promise.all(held);
  await press();
  expect(checkouts).toBe(1);
  expect(opened).toEqual(["https://checkout.example/session"]);
  // Onboarding stamps checkoutOpenedAt here, so a repeat must not reach it.
  expect(opening).toBe(1);

  setSystemTime(new Date(Date.now() + 3_500));
  await press();
  expect(checkouts).toBe(2);
  expect(opened).toHaveLength(2);
});

test("a checkout still opening after 30 seconds lets the next press try again", async () => {
  const hung = [Promise.withResolvers<{ url: string }>(), Promise.withResolvers<{ url: string }>()];
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    return hung[checkouts - 1]!.promise;
  }) as typeof apiClient.createCloudCheckout;
  const upgrade = await renderUpgradeAction();
  const start = Date.now();

  const first = upgrade({ sheet: false });
  setSystemTime(new Date(start + 29_000));
  await upgrade({ sheet: false });
  expect(checkouts).toBe(1);

  setSystemTime(new Date(start + 31_000));
  const second = upgrade({ sheet: false });
  expect(checkouts).toBe(2);

  // The stale first call finishing must not cut the second one's block short.
  hung[0]!.resolve({ url: "https://checkout.example/late" });
  await first;
  setSystemTime(new Date(start + 35_000));
  await upgrade({ sheet: false });
  expect(checkouts).toBe(2);

  hung[1]!.resolve({ url: "https://checkout.example/session" });
  await second;
  expect(opened).toEqual(["https://checkout.example/late", "https://checkout.example/session"]);
});

test("a checkout that cannot be created falls back to the Cloud page once and lets a retry through", async () => {
  let failing = true;
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    if (failing) throw new Error("Stripe is unavailable");
    return { url: "https://checkout.example/session" };
  }) as typeof apiClient.createCloudCheckout;
  apiClient.createBrowserHandoff = (async () => ({ url: "https://gloom.sh/cloud?handoff=one-time" })) as typeof apiClient.createBrowserHandoff;
  const upgrade = await renderUpgradeAction();

  await upgrade({ sheet: false });
  await upgrade({ sheet: false });
  expect(checkouts).toBe(2);
  // The second failure comes within seconds of the first Cloud page tab.
  expect(opened).toEqual(["https://gloom.sh/cloud?handoff=one-time"]);

  failing = false;
  await upgrade({ sheet: false });
  expect(checkouts).toBe(3);
  expect(opened).toEqual(["https://gloom.sh/cloud?handoff=one-time", "https://checkout.example/session"]);
});

const LINK = "https://gloom.sh/checkout/guqc9mh8jhatg6";

/** Mounts a prompt whose browser opens with `open`, and the checkout it creates. */
async function renderHandoff(open: (url: string) => Promise<boolean | void>): Promise<(options?: unknown) => Promise<void>> {
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    return { url: "https://checkout.example/session", link: LINK };
  }) as typeof apiClient.createCloudCheckout;
  let upgrade!: (options?: unknown) => Promise<void>;
  function ProStep() {
    upgrade = useCloudUpgradeAction("onboarding-pro");
    useRendererHost().openExternal = async (url: string) => {
      opened.push(url);
      return open(url);
    };
    return null;
  }
  await tui.render(<ProStep />, { width: 100, height: 40 });
  return upgrade;
}

test("the browser opens the checkout's short link when the server sends one, and Stripe's page when it sends none", async () => {
  let link: string | undefined = LINK;
  apiClient.createCloudCheckout = (async () => {
    checkouts += 1;
    return { url: "https://checkout.example/session", ...(link ? { link } : {}) };
  }) as typeof apiClient.createCloudCheckout;
  const upgrade = await renderUpgradeAction();

  await act(async () => {
    await upgrade({ sheet: false });
  });
  expect(opened).toEqual([LINK]);

  resetCloudUpgradeGuardForTests();
  link = undefined;
  await act(async () => {
    await upgrade({ sheet: false });
  });
  expect(opened).toEqual([LINK, "https://checkout.example/session"]);
  expect(checkouts).toBe(2);
});

test("checkout opens under the hand-off, which reopens the same checkout and closes once Pro arrives", async () => {
  // A terminal over SSH: the opener takes its time, then nothing opened.
  const firstOpen = Promise.withResolvers<boolean>();
  const upgrade = await renderHandoff(async () => (opened.length === 1 ? firstOpen.promise : false));

  await act(async () => {
    void upgrade({ sheet: false });
  });
  // The way back shows as soon as the checkout exists, before the opener settles.
  await tui.waitForFrameToContain(LINK);
  expect(tui.frame()).toContain("Continue in browser");
  expect(tui.frame()).toContain("Waiting for checkout...");

  await act(async () => {
    firstOpen.resolve(false);
  });
  await tui.waitForFrameToContain("No browser opens from here.");

  // The browser button opens the same checkout again, not a second one, and
  // both go through the short link, as the QR code does.
  await act(async () => {
    await tui.emitKeypress({ name: "b", sequence: "b" });
  });
  expect(opened).toEqual([LINK, LINK]);
  expect(checkouts).toBe(1);

  await act(async () => {
    apiClient.restoreCachedUser({ id: "user-free", email: "free@example.com", emailVerified: true, plan: "pro" });
  });
  await tui.waitForFrameToContain("Pro is on.");
  await tui.emitKeypress({ name: "return" });
  await tui.waitForFrameToExclude("Finish checkout in your browser");
});

test("while checkout is open the account is read again, one read at a time, until Pro arrives", async () => {
  const previousSession = accountSession;
  const profile = Promise.withResolvers<AccountProfile>();
  let reads = 0;
  let refreshes = 0;
  apiClient.getAccountProfile = (async () => {
    reads += 1;
    return profile.promise;
  }) as typeof apiClient.getAccountProfile;
  registerAccountSession({
    adoptSession: () => {},
    refreshSession: async () => {
      refreshes += 1;
      apiClient.restoreCachedUser({ id: "user-free", email: "free@example.com", emailVerified: true, plan: "pro" });
    },
  });
  setCheckoutHandoffPollForTests(10);
  try {
    const upgrade = await renderHandoff(async () => true);
    await act(async () => {
      await upgrade({ sheet: false });
    });
    await tui.waitForFrameToContain("Waiting for checkout...");
    // Several ticks pass while the first read is out: no second one starts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(reads).toBe(1);
    expect(refreshes).toBe(0);

    await act(async () => {
      profile.resolve({ id: "user-free", email: "free@example.com", emailVerified: true, plan: "pro" } as AccountProfile);
    });
    await tui.waitForFrameToContain("Pro is on.");
    expect(refreshes).toBe(1);
  } finally {
    setCheckoutHandoffPollForTests();
    registerAccountSession(previousSession);
  }
});

test("signed out, an upgrade opens the Pro sheet in the app, not a browser page a terminal may never show, and counts one press", async () => {
  // Over SSH, `$` and the menu's "Upgrade to Pro" opened the Cloud page in no browser and seemed to do nothing.
  // A bare sign-up form in its place said nothing of Pro, its price or the trial.
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  const intents = spyOn(researchActivity, "recordResearchActivity").mockImplementation(() => {});
  const pricing = spyOn(apiClient, "getCloudPricing").mockRejectedValue(new Error("Fixture has no pricing"));
  const plan = spyOn(apiClient, "getCloudAccountPlan").mockRejectedValue(new Error("Signed out"));
  try {
    let upgrade!: (options?: unknown) => Promise<void>;
    function Footer() {
      upgrade = useCloudUpgradeAction("ticker-footer");
      useRendererHost().openExternal = async (url: string) => {
        opened.push(url);
      };
      return <AuthDialogHost />;
    }
    await tui.render(<Footer />, { width: 90, height: 30 });
    act(() => {
      void upgrade();
    });
    await tui.waitForFrameToContain("New accounts get Pro free for 7 days, then $70/mo.");
    const sheet = tui.frame();
    expect(sheet).toContain("One better trade pays for Pro");
    expect(sheet).toContain("Start free trial");
    expect(sheet).toContain("Sign up free");
    // Nothing about an account yet, and nobody is asked for one.
    expect(sheet).not.toContain("Create your free Gloom Cloud account");
    expect(plan).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
    expect(intents.mock.calls.filter(([event]) => event === "upgrade_intent")).toHaveLength(1);
    // Another press while the sheet is up asks for nothing new and counts nothing.
    await act(async () => {
      await upgrade();
    });
    expect(intents.mock.calls.filter(([event]) => event === "upgrade_intent")).toHaveLength(1);
    await tui.destroy();
  } finally {
    intents.mockRestore();
    pricing.mockRestore();
    plan.mockRestore();
  }

  // With no dialog host to ask, the Cloud page is still where it goes.
  const bare = await renderUpgradeAction();
  await act(async () => {
    await bare();
  });
  expect(opened).toHaveLength(1);
  expect(opened[0]).toContain("gloom.sh/cloud");
});

/** Signed out with the sheet up, as a press on any upgrade prompt leaves it; `requests` takes what the sheet asks for next. */
async function openSignedOutSheet(requests: AuthDialogRequest[]): Promise<() => void> {
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  const upgrade = await renderUpgradeAction();
  const release = interceptAuthDialogForTests((request) => requests.push(request));
  act(() => {
    void upgrade();
  });
  await tui.waitForFrameToContain("Start free trial");
  return release;
}

test("the signed-out sheet's trial button asks for the account and its other button only signs up", async () => {
  const pricing = spyOn(apiClient, "getCloudPricing").mockRejectedValue(new Error("Fixture has no pricing"));
  const requests: AuthDialogRequest[] = [];
  let release = () => {};
  try {
    release = await openSignedOutSheet(requests);
    expect(requests).toEqual([]);
    await act(async () => {
      tui.setup().mockInput.pressEnter();
      await tui.setup().renderOnce();
    });
    await tui.renderFrames(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ mode: "signup", checkout: true, reason: "First an account, then Pro." });
    expect(requests[0]!.onSignedIn).toBeFunction();
    release();
    await tui.destroy();

    release = await openSignedOutSheet(requests);
    await tui.clickFrameText("Sign up free");
    await tui.renderFrames(2);
    // A plain sign-up: nothing goes on after it, and it is asked where it heard of Gloom like any other.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({ mode: "signup" });
    release();
    await tui.destroy();

    // Its key does the same for a keyboard.
    release = await openSignedOutSheet(requests);
    await act(async () => {
      tui.setup().mockInput.pressKey("f");
      await tui.setup().renderOnce();
    });
    await tui.renderFrames(2);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual({ mode: "signup" });
    release();
    await tui.destroy();

    // Closed, it asks for nothing.
    release = await openSignedOutSheet(requests);
    await act(async () => {
      tui.setup().mockInput.pressEscape();
      await tui.setup().renderOnce();
    });
    await tui.renderFrames(2);
    expect(requests).toHaveLength(3);
    expect(checkouts).toBe(0);
  } finally {
    release();
    pricing.mockRestore();
  }
});

test("once signed in from the sheet, an account without Pro reads its own terms on the interval it chose, and a Pro login gets nothing", async () => {
  const pricing = spyOn(apiClient, "getCloudPricing").mockRejectedValue(new Error("Fixture has no pricing"));
  const portal = spyOn(apiClient, "createBillingPortal").mockResolvedValue({ url: "https://portal.example/session" } as never);
  const plan = spyOn(apiClient, "getCloudAccountPlan");
  const requests: AuthDialogRequest[] = [];
  let release = () => {};
  try {
    const signIn = async (user: Parameters<typeof apiClient.restoreCachedUser>[0] & object, trialAvailable: boolean) => {
      plan.mockResolvedValue({ effectivePlan: user.plan, trialAvailable, paymentFailed: false } as never);
      release = await openSignedOutSheet(requests);
      // Yearly, then the trial.
      await act(async () => {
        tui.setup().mockInput.pressArrow("right");
        await tui.setup().renderOnce();
      });
      await act(async () => {
        tui.setup().mockInput.pressEnter();
        await tui.setup().renderOnce();
      });
      await tui.renderFrames(2);
      expect(requests.at(-1)?.mode).toBe("signup");
      apiClient.setSessionToken("cloud-upgrade-session");
      apiClient.restoreCachedUser(user);
      await act(async () => {
        requests.at(-1)!.onSignedIn!(user as never);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };

    // A new account: what today costs and the day of the first charge, which the signed-out sheet could not say.
    await signIn({ id: "user-new", email: "new@example.com", emailVerified: true, plan: "free" }, true);
    await tui.waitForFrameToContain("$0 today, then $630/yr from");
    expect(tui.frame()).toContain("Not now");
    expect(tui.frame()).not.toContain("New accounts get");
    release();
    await tui.destroy();

    // An account that used its trial would be billed today, and reads that before any checkout opens.
    await signIn({ id: "user-back", email: "back@example.com", emailVerified: true, plan: "free" }, false);
    await tui.waitForFrameToContain("$630/yr, billed today.");
    expect(tui.frame()).toContain("Continue to checkout");
    release();
    await tui.destroy();

    await signIn({ id: "user-pro", email: "pro@example.com", emailVerified: true, plan: "pro" }, false);
    await tui.renderFrames(2);
    expect(tui.frame()).not.toContain("One better trade pays for Pro");
    expect(opened).toEqual([]);
    expect(portal).not.toHaveBeenCalled();
    expect(checkouts).toBe(0);
  } finally {
    release();
    pricing.mockRestore();
    portal.mockRestore();
    plan.mockRestore();
  }
});

test("the UPGRADE command still opens checkout after the newest prompt closes", async () => {
  apiClient.setSessionToken(null);
  apiClient.restoreCachedUser(null);
  let showFooter!: (shown: boolean) => void;
  function Prompts() {
    const [footer, setFooter] = useState(true);
    showFooter = setFooter;
    return (
      <>
        <Prompt placement="status-widget" />
        {footer ? <Prompt placement="news-footer" /> : null}
      </>
    );
  }
  await tui.render(<Prompts />);
  await act(async () => {
    showFooter(false);
    await tui.setup().renderOnce();
  });
  // Signed out, the remaining opener sends the person to the Cloud page; what
  // matters is that the command did not fall back to the account pane.
  expect(openCloudUpgradeUrl("command")).toBe(true);
  await tui.destroy();
  expect(openCloudUpgradeUrl("command")).toBe(false);
});
