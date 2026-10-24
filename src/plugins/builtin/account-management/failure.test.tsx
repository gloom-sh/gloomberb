import { expect, spyOn, test } from "bun:test";
import { InputHostProvider } from "../../../react/input";
import { DialogHostProvider } from "../../../ui/dialog";
import { apiClient } from "../../../api-client";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { debugLog } from "../../../utils/debug-log";
import { chatController } from "../chat/controller";
import { AccountManagementPane } from "./pane";

const dom = createDomTestHarness();

test("a rejected account session refresh keeps the sign-in wall and logs no credentials", async () => {
  const now = spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
  const signedIn = spyOn(apiClient, "isSignedIn").mockReturnValue(false);
  const refresh = spyOn(chatController, "refreshSession").mockRejectedValue(new Error("token=private account=private"));
  const logged: unknown[][] = [];
  const stop = debugLog.subscribe((entry) => {
    if (entry.source === "account-management.pane") logged.push([entry.level, entry.message, entry.data]);
  });
  try {
    const paneId = "account-failure";
    const config = createTestPaneConfig("unused-account-failure", { instanceId: paneId, paneId: "account-management" });
    const container = await dom.render(
      <InputHostProvider host={{ useShortcut() {}, useBeforeShortcut() {}, useViewport: () => ({ width: 80, height: 40 }) }}>
        <DialogHostProvider dialog={{ alert: async () => {}, prompt: async () => undefined }} isOpen={false}>
          <TestPaneProvider state={createInitialState(config)} paneId={paneId} pluginId="cloud" runtime={createTestPluginRuntime()}>
            <AccountManagementPane paneId={paneId} paneType="account-management" focused width={80} height={40} />
          </TestPaneProvider>
        </DialogHostProvider>
      </InputHostProvider>,
    );
    expect(container.textContent).toContain("Sign in");
    expect(logged).toEqual([["warn", expect.stringMatching(/^Refresh account session failed(?: \(suppressed repeats: \d+\))?$/), undefined]]);
  } finally {
    stop();
    refresh.mockRestore();
    signedIn.mockRestore();
    now.mockRestore();
  }
});
