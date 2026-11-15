import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useLayoutEffect, useRef } from "react";
import { apiClient, setCloudApiFetchTransport, type AccountProfile } from "../../../api-client";
import { InputHostProvider, shouldDeliverShortcut, type InputHost, type KeyEventLike, type ShortcutOptions } from "../../../react/input";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { DialogHostProvider } from "../../../ui/dialog";
import { chatController } from "../chat/controller";
import { AccountManagementPane } from "./pane";

const dom = createDomTestHarness();
const restore: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore();
  setCloudApiFetchTransport(null);
});

const offer = { currency: "usd", monthlyAmount: 7000, yearlyAmount: 63000, twelveMonthlyAmount: 84000, savingsAmount: 21000 };
const review = {
  token: "v1.review.sig",
  expiresAt: "2026-11-16T12:10:00.000Z",
  currency: "usd",
  amountDue: 56729,
  yearlyAmount: 60929,
  credit: 4200,
  tax: 0,
  balanceApplied: 0,
  renewalAmount: 63000,
  renewsAt: "2027-11-04T12:00:00.000Z",
  renewalTaxed: false,
  offer,
};
const invoiceUrl = "https://invoice.stripe.com/i/acct_1/test_switch";

type Answer = { status?: number; body: unknown };

const PHASES = ["capture", "before", "normal", "after", "idle"] as const;

/**
 * Keys delivered to the pane's shortcuts phase by phase, in the order they
 * mounted. `afterCommit` runs inside every commit of the pane, before any
 * passive effect: a key sent from there is one that lands between a render
 * and the effects that follow it.
 */
function keyboard(afterCommit: () => void) {
  const handlers = new Set<{ current: { handler: (event: KeyEventLike) => void; options?: ShortcutOptions } }>();
  const host: InputHost = {
    useShortcut(handler, options) {
      const latest = useRef({ handler, options });
      latest.current = { handler, options };
      useLayoutEffect(() => {
        handlers.add(latest);
        return () => { handlers.delete(latest); };
      }, []);
      useLayoutEffect(afterCommit);
    },
    useBeforeShortcut() {},
    useViewport: () => ({ width: 90, height: 50 }),
  };
  const press = (name: string, repeat = false) => {
    let prevented = false;
    let stopped = false;
    const event: KeyEventLike = {
      key: name,
      name,
      sequence: name === "return" ? "\r" : name,
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
      repeat,
      get defaultPrevented() { return prevented; },
      get propagationStopped() { return stopped; },
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
    };
    for (const phase of PHASES) {
      for (const entry of [...handlers]) {
        const { handler, options } = entry.current;
        if (options?.enabled === false || (options?.phase ?? "normal") !== phase) continue;
        if (!shouldDeliverShortcut(event, options?.allowEditable ?? false)) continue;
        handler(event);
        if (stopped) return;
      }
    }
  };
  return { host, press };
}

/** The pane on its Pro tab, for an account and a stand-in billing API. */
async function proTab(
  plan: { plan: "free" | "pro"; trialEndsAt?: string | null },
  answer: (path: string, body: unknown) => Answer | Promise<Answer>,
  inputHost: InputHost = { useShortcut() {}, useBeforeShortcut() {}, useViewport: () => ({ width: 90, height: 50 }) },
) {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  restore.push(
    spyOn(apiClient, "isSignedIn").mockReturnValue(true),
    spyOn(chatController, "subscribe").mockReturnValue(() => {}),
    spyOn(chatController, "refreshSession").mockResolvedValue(undefined as never),
    spyOn(apiClient, "getAccountProfile").mockResolvedValue({ ...plan, email: "trader@example.test", emailVerified: true } as AccountProfile),
    spyOn(apiClient, "getCloudPricing").mockRejectedValue(new Error("offline")),
    spyOn(apiClient, "getCloudAccountPlan").mockResolvedValue({ effectivePlan: plan.plan, subscription: { status: "active" } }),
    spyOn(apiClient, "getReferralInvite").mockRejectedValue(new Error("unavailable")),
  );
  setCloudApiFetchTransport((async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method: init?.method ?? "GET", body });
    const reply = await answer(path, body);
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch);
  const config = createTestPaneConfig("unused-yearly-test", { instanceId: "account-yearly", paneId: "account-management" });
  const app = createInitialState(config);
  app.paneState["account-yearly"] = { pluginState: { cloud: { activeTab: "pro" } } };
  const container = await dom.render(
    <InputHostProvider host={inputHost}>
      <DialogHostProvider dialog={{ alert: async () => {}, prompt: async () => undefined }} isOpen={false}>
        <TestPaneProvider state={app} paneId="account-yearly" pluginId="cloud" runtime={createTestPluginRuntime()}>
          <AccountManagementPane paneId="account-yearly" paneType="account-management" focused width={90} height={50} />
        </TestPaneProvider>
      </DialogHostProvider>
    </InputHostProvider>,
  );
  await act(() => Bun.sleep(0));
  await act(() => Bun.sleep(0));
  const button = (label: string | RegExp) => [...container.querySelectorAll("button")]
    .find((node) => typeof label === "string" ? node.textContent === label : label.test(node.textContent ?? ""));
  const press = async (label: string | RegExp) => {
    await act(async () => { button(label)!.click(); await Bun.sleep(0); });
    await act(() => Bun.sleep(0));
  };
  return { container, requests, button, press };
}

test("a monthly payer sees the offer from the server's amounts, and its review changes nothing", async () => {
  const screen = await proTab({ plan: "pro" }, (path) => path === "/stripe/subscription/yearly"
    ? { body: { state: "available", offer } }
    : { body: { review } });
  expect(screen.container.textContent).toContain("Yearly is $630 a year, $210 less than twelve monthly payments of $70 ($840).");
  expect(screen.container.textContent).not.toMatch(/months? free/i);
  await screen.press("Review Yearly");
  const text = screen.container.textContent ?? "";
  for (const line of ["$609.29", "Credit for the rest of this month", "-$42.00", "Due today", "$567.29", "Then $630.00 a year, renewing"]) {
    expect(text).toContain(line);
  }
  expect(screen.button("Pay $567.29 and Switch")).toBeDefined();
  expect(screen.button("Not Now")).toBeDefined();
  expect(screen.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    "GET /stripe/subscription/yearly",
    "POST /stripe/subscription/yearly/preview",
  ]);
  await screen.press("Not Now");
  expect(screen.button("Review Yearly")).toBeDefined();
  expect(screen.requests.some((request) => request.path.endsWith("/confirm"))).toBe(false);
});

test("an Enter held from Review Yearly lands on Not Now as the review opens, never on the payment", async () => {
  let page: HTMLElement | null = null;
  let repeated = false;
  const keys = keyboard(() => {
    // The first commit that draws the payment: a held key's repeat arrives now.
    const pay = [...(page?.querySelectorAll("button") ?? [])].some((node) => node.textContent === "Pay $567.29 and Switch");
    if (!pay || repeated) return;
    repeated = true;
    keys.press("return", true);
  });
  const screen = await proTab({ plan: "pro" }, (path) => {
    if (path === "/stripe/subscription/yearly") return { body: { state: "available", offer } };
    if (path.endsWith("/preview")) return { body: { review } };
    return { body: { state: "switched", amountPaid: 56729, renewalAmount: 63000, renewsAt: review.renewsAt } };
  }, keys.host);
  page = screen.container;
  // From Manage Pro down to the Yearly row, then Enter.
  await act(async () => { keys.press("down"); await Bun.sleep(0); });
  await act(async () => { keys.press("return"); await Bun.sleep(0); });
  await act(() => Bun.sleep(0));
  await act(() => Bun.sleep(0));
  expect(repeated).toBe(true);
  expect(screen.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
    "GET /stripe/subscription/yearly",
    "POST /stripe/subscription/yearly/preview",
  ]);
  // The repeat pressed Not Now: the review closed and the offer is back.
  expect(screen.button("Pay $567.29 and Switch")).toBeUndefined();
  expect(screen.button("Review Yearly")).toBeDefined();
  expect(screen.container.textContent).not.toContain("You're on yearly billing.");
});

test("confirming sends the reviewed token once, however often it is pressed, and says done only when paid", async () => {
  const confirm = Promise.withResolvers<Answer>();
  const screen = await proTab({ plan: "pro" }, (path) => {
    if (path === "/stripe/subscription/yearly") return { body: { state: "available", offer } };
    if (path.endsWith("/preview")) return { body: { review } };
    return confirm.promise;
  });
  await screen.press("Review Yearly");
  const pay = screen.button("Pay $567.29 and Switch")!;
  await act(async () => { pay.click(); pay.click(); await Bun.sleep(0); });
  expect(screen.container.textContent).toContain("Switching...");
  expect(screen.container.textContent).not.toContain("You're on yearly billing.");
  await act(async () => {
    confirm.resolve({ body: { state: "switched", amountPaid: 56729, renewalAmount: 63000, renewsAt: review.renewsAt } });
    await Bun.sleep(0);
  });
  await act(() => Bun.sleep(0));
  const confirms = screen.requests.filter((request) => request.path.endsWith("/confirm"));
  expect(confirms).toEqual([{ path: "/stripe/subscription/yearly/confirm", method: "POST", body: { token: "v1.review.sig" } }]);
  expect(screen.container.textContent).toContain("You're on yearly billing. Paid $567.29 today.");
});

test("a payment the bank must confirm is not a switch: the row links to Stripe's invoice only", async () => {
  const opened: string[] = [];
  restore.push(spyOn(noopRendererHost, "openExternal").mockImplementation(async (url) => { opened.push(url); }));
  let confirmed = false;
  const screen = await proTab({ plan: "pro" }, (path) => {
    if (path === "/stripe/subscription/yearly") {
      return confirmed
        ? { body: { state: "pending", invoiceUrl, expiresAt: "2026-11-17T12:00:00.000Z" } }
        : { body: { state: "available", offer } };
    }
    if (path.endsWith("/preview")) return { body: { review } };
    confirmed = true;
    return { body: { state: "payment_required", invoiceUrl, expiresAt: "2026-11-17T12:00:00.000Z" } };
  });
  await screen.press("Review Yearly");
  await screen.press("Pay $567.29 and Switch");
  const text = screen.container.textContent ?? "";
  expect(text).toContain("You stay on monthly billing until it is paid.");
  expect(text).not.toContain("You're on yearly billing.");
  await screen.press("Confirm Payment");
  expect(opened).toEqual([invoiceUrl]);
});

test("a total that moved is never charged: the review closes and says why", async () => {
  const screen = await proTab({ plan: "pro" }, (path) => {
    if (path === "/stripe/subscription/yearly") return { body: { state: "available", offer } };
    if (path.endsWith("/preview")) return { body: { review } };
    return { status: 409, body: { code: "review_changed", error: "The total changed since you reviewed it. Review it again." } };
  });
  await screen.press("Review Yearly");
  await screen.press("Pay $567.29 and Switch");
  expect(screen.container.textContent).toContain("The total changed since you reviewed it. Review it again.");
  expect(screen.button("Pay $567.29 and Switch")).toBeUndefined();
  expect(screen.button("Review Yearly")).toBeDefined();
});

test("free and trial accounts are not asked, and an account the server refuses sees nothing", async () => {
  for (const plan of [{ plan: "free" as const }, { plan: "pro" as const, trialEndsAt: "2099-01-01T00:00:00.000Z" }]) {
    const screen = await proTab(plan, () => ({ body: { state: "available", offer } }));
    expect(screen.requests).toEqual([]);
    expect(screen.button("Review Yearly")).toBeUndefined();
    for (const spy of restore.splice(0)) spy.mockRestore();
  }
  const refused = await proTab({ plan: "pro" }, () => ({ body: { state: "unavailable" } }));
  expect(refused.requests.map((request) => request.path)).toEqual(["/stripe/subscription/yearly"]);
  expect(refused.container.textContent).not.toContain("Yearly is");
});
