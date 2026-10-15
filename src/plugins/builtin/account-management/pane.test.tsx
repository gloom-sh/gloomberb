import { expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { chatController } from "../chat/controller";
import { AccountManagementPane } from "./pane";

const tui = createOpenTuiTestHarness();

test("a failed first profile load uses the shared unavailable sentence", async () => {
  const signedIn = spyOn(apiClient, "isSignedIn").mockReturnValue(true);
  const profile = spyOn(apiClient, "getAccountProfile").mockRejectedValue(new Error("Gloom Cloud profile exploded"));
  const refresh = spyOn(chatController, "refreshSession").mockResolvedValue(undefined);
  const id = "account-management:test";
  const state = createInitialState(createTestPaneConfig("/tmp/account-test", {
    paneId: "account-management",
    instanceId: id,
  }));
  try {
    await act(async () => {
      await tui.render(
        <TestPaneFrame state={state} paneId={id} pluginId="account" runtime={createTestPluginRuntime()} width={80} height={24}>
          {(body) => <AccountManagementPane paneId={id} paneType="account-management" width={body.width} height={body.height} focused />}
        </TestPaneFrame>,
        { width: 80, height: 24 },
      );
    });
    const frame = await tui.waitForFrameToContain("Account profile unavailable.");
    expect(frame).not.toContain("Gloom Cloud profile exploded");
    expect(frame).not.toContain("Public Profile");
  } finally {
    signedIn.mockRestore();
    profile.mockRestore();
    refresh.mockRestore();
  }
});
