import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient, setCloudApiFetchTransport, type AccountProfile } from "../../../api-client";
import { InputHostProvider } from "../../../react/input";
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

async function account(status = "past_due", plan: "free" | "pro" = "free") {
  const state = { status };
  restore.push(
    spyOn(apiClient, "isSignedIn").mockReturnValue(true),
    spyOn(chatController, "subscribe").mockReturnValue(() => {}),
    spyOn(chatController, "refreshSession").mockResolvedValue(undefined as never),
    spyOn(apiClient, "getAccountProfile").mockResolvedValue({ plan, email: "trader@example.test", emailVerified: true } as AccountProfile),
    spyOn(apiClient, "getCloudPricing").mockRejectedValue(new Error("offline")),
    spyOn(apiClient, "getCloudAccountPlan").mockImplementation(async () => ({ effectivePlan: plan, paymentFailed: plan === "free", subscription: { status: state.status } })),
    spyOn(apiClient, "getReferralInvite").mockRejectedValue(new Error("unavailable")),
  );
  const config = createTestPaneConfig("unused-payment-test", { instanceId: "account-payment", paneId: "account-management" });
  const app = createInitialState(config);
  app.paneState["account-payment"] = { pluginState: { cloud: { activeTab: "pro" } } };
  const container = await dom.render(
    <InputHostProvider host={{ useShortcut() {}, useBeforeShortcut() {}, useViewport: () => ({ width: 80, height: 40 }) }}>
      <DialogHostProvider dialog={{ alert: async () => {}, prompt: async () => undefined }} isOpen={false}>
        <TestPaneProvider state={app} paneId="account-payment" pluginId="cloud" runtime={createTestPluginRuntime()}>
          <AccountManagementPane paneId="account-payment" paneType="account-management" focused width={80} height={40} />
        </TestPaneProvider>
      </DialogHostProvider>
    </InputHostProvider>,
  );
  await act(() => Bun.sleep(0));
  const pay = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Pay invoice");
  return { container, state, pay };
}

test("personal unpaid billing shows the row even with team Pro, and paid billing leaves it out", async () => {
  const screen = await account("unpaid", "pro");
  expect(screen.pay()).toBeDefined();
  expect(screen.container.textContent).toContain("Your Pro payment did not go through.");
  screen.state.status = "active";
  await act(() => Bun.sleep(5_100));
  expect(screen.pay()).toBeUndefined();
  expect(screen.container.textContent).not.toContain("Your Pro payment did not go through.");
}, 10_000);

test("Pay invoice uses only the invoice-only endpoint and clears after payment", async () => {
  const requests: string[] = [];
  const opened: string[] = [];
  const screen = await account();
  restore.push(spyOn(noopRendererHost, "openExternal").mockImplementation(async url => { opened.push(url); }));
  setCloudApiFetchTransport((async input => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path !== "/stripe/pay-invoice") throw new Error("Unexpected billing request");
    screen.state.status = "active";
    return Response.json({ url: "https://invoice.stripe.com/i/test_current" });
  }) as typeof fetch);
  await act(async () => { screen.pay()!.click(); await Bun.sleep(0); });
  expect(requests).toEqual(["/stripe/pay-invoice"]);
  expect(opened).toEqual(["https://invoice.stripe.com/i/test_current"]);
  expect(screen.pay()).toBeUndefined();
});

test("stale and error responses stay on the row, refresh, and never start checkout or open a URL", async () => {
  const requests: string[] = [];
  const opened: string[] = [];
  const screen = await account();
  restore.push(spyOn(noopRendererHost, "openExternal").mockImplementation(async url => { opened.push(url); }));
  let responseStatus = 409;
  setCloudApiFetchTransport((async input => {
    requests.push(new URL(String(input)).pathname);
    return Response.json({ error: "No payable invoice is available." }, { status: responseStatus });
  }) as typeof fetch);
  for (const status of [409, 404, 502]) {
    responseStatus = status;
    await act(async () => { screen.pay()!.click(); await Bun.sleep(0); });
    expect(screen.container.textContent).toContain("Could not open invoice payment. Try again.");
    expect(screen.pay()).toBeDefined();
  }
  expect(requests).toEqual(["/stripe/pay-invoice", "/stripe/pay-invoice", "/stripe/pay-invoice"]);
  expect(opened).toEqual([]);
  screen.state.status = "active";
  await act(async () => { screen.pay()!.click(); await Bun.sleep(0); });
  expect(screen.pay()).toBeUndefined();
});

test("repeated presses while opening issue only one invoice request", async () => {
  const pending = Promise.withResolvers<Response>();
  const screen = await account();
  let requests = 0;
  restore.push(spyOn(noopRendererHost, "openExternal").mockResolvedValue(true));
  setCloudApiFetchTransport((async () => { requests++; return pending.promise; }) as unknown as typeof fetch);
  await act(async () => { screen.pay()!.click(); screen.pay()?.click(); await Bun.sleep(0); });
  expect(requests).toBe(1);
  await act(async () => { pending.resolve(Response.json({ url: "https://invoice.stripe.com/i/test_current" })); await Bun.sleep(0); });
});
