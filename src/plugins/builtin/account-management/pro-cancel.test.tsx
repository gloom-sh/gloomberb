import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness, TestDialogProvider, type TestKeyEvent } from "../../../renderers/opentui/test-utils";
import { useDialog, type DialogApi } from "../../../ui/dialog";
import { cancelProAfterSteps, type ProCancelOutcome } from "./pro-cancel";

const tui = createOpenTuiTestHarness({ width: 90, height: 30 });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

let dialog: DialogApi | null = null;
function DialogCapture() {
  dialog = useDialog();
  return null;
}

const PLAN = { currentPeriodEnd: "2026-12-10T12:00:00Z" };
const Y: TestKeyEvent = { name: "y", sequence: "y" };
const N: TestKeyEvent = { name: "n", sequence: "n" };
const DOWN: TestKeyEvent = { name: "down" };

/** The dialog's words as one line, so a sentence reads the same wherever the frame wraps it. */
function dialogText(): string {
  return tui.frame().split("\n").map((line) => line.replace(/[│┌┐└┘─]/g, " ").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
}

/**
 * gloom.sh's cancel endpoints as the real API client calls them, answered as
 * the server does. `offer` is what the flow is offered as it opens.
 */
function serve(offer: unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(request.url).pathname.replace(/^.*\/stripe\//, "/stripe/");
    const body = request.method === "GET" ? undefined : await request.json();
    calls.push({ method: request.method, path, ...(body === undefined ? {} : { body }) });
    if (path === "/stripe/subscription/retention-offer") {
      return request.method === "GET"
        ? Response.json(offer)
        : Response.json({ offer: "discount", extendedTrialEndsAt: null });
    }
    if (path === "/stripe/subscription/cancel") return Response.json({ canceled: true, endedNow: false });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}

const API = {
  retentionOffer: (signal: AbortSignal) => apiClient.getCloudRetentionOffer({ signal }),
  acceptOffer: (feedback: Parameters<typeof apiClient.acceptCloudRetentionOffer>[0]) => apiClient.acceptCloudRetentionOffer(feedback),
  cancel: (feedback: Parameters<typeof apiClient.cancelCloudSubscription>[0]) => apiClient.cancelCloudSubscription(feedback),
};

/** Opens the flow; `step` waits for a dialog and presses keys in it, `result` waits for the end. */
async function openFlow() {
  let flow: Promise<ProCancelOutcome> = Promise.resolve(null);
  await act(async () => {
    flow = cancelProAfterSteps(dialog!, PLAN, API);
    await Bun.sleep(0);
  });
  return {
    async step(text: string, ...keys: TestKeyEvent[]) {
      await tui.waitForFrameToContain(text);
      for (const key of keys) await tui.emitKeypress(key, { trackPropagation: true });
    },
    async result() {
      const outcome = await act(() => flow);
      await tui.waitForFrameToExclude("Cancel Pro?");
      return outcome;
    },
  };
}

const DISCOUNT = {
  offer: "discount",
  extendedTrialEndsAt: null,
  keptPrice: { amount: 5000, listAmount: 7000, interval: "month" },
};

// The paid cancel is gloom.sh's cancel window, step for step and request for
// request: why, the offer the server has, then the confirmation. It stops the
// renewal only (no endTrialNow), and only after that last step.
test("a paid plan is cancelled through the existing endpoint after the reason, the offer and the confirmation", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const calls = serve(DISCOUNT);

  const flow = await openFlow();
  await flow.step("What made you decide to cancel? (optional)");
  expect(dialogText()).toContain("Pro stays on until 10 Dec 2026.");
  // Third reason, then Continue.
  await flow.step("Keep Pro", DOWN, DOWN, DOWN, { name: "return" });
  await flow.step("Get 50% Off for 3 Months");
  expect(dialogText()).toContain("Fair. The price has to be worth it. Take 50% off your next three months while we improve it. Your payment on 10 Dec 2026 drops to half price.");
  // No thanks: on to the confirmation.
  await flow.step("Get 50% Off for 3 Months", N);
  await flow.step("Keep My Subscription");
  expect(dialogText()).toContain("Your price is $50/mo. New subscribers pay $70/mo. If you cancel, you lose this price. Coming back costs $70/mo. Pro stays on until 10 Dec 2026. Cancelling now stops the renewal after that date.");
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  await flow.step("Keep My Subscription", Y);

  expect(await flow.result()).toEqual({ kind: "cancelled", message: "Cancelled. Pro stays on until 10 Dec 2026." });
  expect(calls).toEqual([
    { method: "GET", path: "/stripe/subscription/retention-offer" },
    { method: "POST", path: "/stripe/subscription/cancel", body: { reason: "too_expensive" } },
  ]);
});

test("Enter on the confirmation and Esc on any step keep Pro, with nothing sent", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const calls = serve(DISCOUNT);

  const enter = await openFlow();
  await enter.step("Keep Pro", { name: "return" });
  await enter.step("Get 50% Off for 3 Months", N);
  await enter.step("Keep My Subscription", { name: "return" });
  expect(await enter.result()).toBeNull();

  // Esc on the offer leaves the flow; it is not "continue cancelling".
  const escOffer = await openFlow();
  await escOffer.step("Keep Pro", { name: "return" });
  await escOffer.step("Get 50% Off for 3 Months", { name: "escape" });
  expect(await escOffer.result()).toBeNull();

  const escReason = await openFlow();
  await escReason.step("Keep Pro", { name: "escape" });
  expect(await escReason.result()).toBeNull();

  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
});

test("the offer taken goes through the server's own offer endpoint, and a plan with no offer skips that step", async () => {
  await tui.render(<TestDialogProvider><DialogCapture /></TestDialogProvider>);
  const calls = serve(DISCOUNT);

  const saved = await openFlow();
  await saved.step("Keep Pro", DOWN, { name: "return" });
  await saved.step("Get 50% Off for 3 Months", { name: "return" });
  expect(await saved.result()).toEqual({ kind: "saved", message: "50% off applied to your next three months." });
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/stripe/subscription/retention-offer", body: { reason: "bugs" } });

  // Yearly, or the offer used already: why, then the confirmation, as on gloom.sh.
  const plain = serve({ offer: null, extendedTrialEndsAt: null, keptPrice: null });
  const flow = await openFlow();
  await flow.step("Keep Pro", { name: "return" });
  await flow.step("Keep My Subscription");
  expect(tui.frame()).not.toContain("Your price is");
  await flow.step("Keep My Subscription", Y);
  expect(await flow.result()).toEqual({ kind: "cancelled", message: "Cancelled. Pro stays on until 10 Dec 2026." });
  expect(plain).toEqual([
    { method: "GET", path: "/stripe/subscription/retention-offer" },
    { method: "POST", path: "/stripe/subscription/cancel", body: {} },
  ]);
});
