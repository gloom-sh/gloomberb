import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { InputHostProvider } from "../../../react/input";
import { DialogHostProvider } from "../../../ui/dialog";
import { apiClient, type AccountProfile } from "../../../api-client";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createInitialState } from "../../../state/app/context";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { chatController } from "../chat/controller";
import { AccountManagementPane } from "./pane";

const dom = createDomTestHarness();
const restore: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const spy of restore.splice(0)) spy.mockRestore();
});

async function openProTab(invite: () => Promise<{ url: string; earned: number; cap: number }>) {
  restore.push(
    spyOn(apiClient, "isSignedIn").mockReturnValue(true),
    spyOn(chatController, "subscribe").mockReturnValue(() => {}),
    spyOn(chatController, "refreshSession").mockResolvedValue(undefined as never),
    spyOn(apiClient, "getAccountProfile").mockResolvedValue({ plan: "free", email: "a@example.com" } as AccountProfile),
    spyOn(apiClient, "getCloudPricing").mockRejectedValue(new Error("offline")),
    spyOn(apiClient, "getCloudAccountPlan").mockRejectedValue(new Error("offline")),
    spyOn(apiClient, "getReferralInvite").mockImplementation(invite),
  );
  const paneId = "account-invite";
  const config = createTestPaneConfig("unused-account-invite", { instanceId: paneId, paneId: "account-management" });
  const state = createInitialState(config);
  state.paneState[paneId] = { pluginState: { cloud: { activeTab: "pro" } } };
  const container = await dom.render(
    <InputHostProvider host={{ useShortcut() {}, useBeforeShortcut() {}, useViewport: () => ({ width: 80, height: 40 }) }}>
      <DialogHostProvider dialog={{ alert: async () => {}, prompt: async () => undefined }} isOpen={false}>
        <TestPaneProvider state={state} paneId={paneId} pluginId="cloud" runtime={createTestPluginRuntime()}>
          <AccountManagementPane paneId={paneId} paneType="account-management" focused width={80} height={40} />
        </TestPaneProvider>
      </DialogHostProvider>
    </InputHostProvider>,
  );
  await act(() => Bun.sleep(0));
  return container;
}

test("the invite row shows the link and the months earned, and Copy gives the whole link", async () => {
  const copied: string[] = [];
  restore.push(spyOn(noopRendererHost, "copyText").mockImplementation(async (text) => { copied.push(text); }));
  const container = await openProTab(async () => ({ url: "https://gloom.sh/i/k7m2qx9a", earned: 1, cap: 3 }));

  expect(container.textContent).toContain("gloom.sh/i/k7m2qx9a");
  expect(container.textContent).toContain("Free months earned: 1 of 3");
  const copy = [...container.querySelectorAll("button")].find((button) => button.textContent === "Copy");
  await act(async () => {
    copy!.click();
    await Bun.sleep(0);
  });
  expect(copied).toEqual(["https://gloom.sh/i/k7m2qx9a"]);
});

test("a server without invites leaves the row out of the Pro tab", async () => {
  const container = await openProTab(async () => {
    throw new Error("Not found");
  });
  expect(container.textContent).toContain("Upgrade to Pro");
  expect(container.textContent).not.toContain("Invite");
  expect(container.textContent).not.toContain("Free months");
});
