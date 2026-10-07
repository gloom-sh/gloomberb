import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import * as activity from "../../../api-client/research-activity";
import * as wallSummary from "../../../api-client/wall-summary";
import { Button, EmptyState } from "../../../components";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { Box } from "../../../ui";
import { SignInWall } from "./auth-actions";
import * as authDialog from "./auth-dialog";

const tui = createOpenTuiTestHarness({ width: 84, height: 20 });
const restore: Array<() => void> = [];
const openCommandBar = mock((_query?: string) => {});

beforeEach(() => {
  openCommandBar.mockClear();
  const user = spyOn(apiClient, "getCurrentUser").mockReturnValue(null);
  const viewed = spyOn(activity, "recordWallViewed").mockImplementation(() => {});
  const clicked = spyOn(activity, "recordWallCtaClicked").mockImplementation(() => {});
  const auth = spyOn(authDialog, "requestAuthDialog").mockReturnValue(true);
  restore.push(() => user.mockRestore(), () => viewed.mockRestore(), () => clicked.mockRestore(), () => auth.mockRestore());
});
afterEach(() => { restore.splice(0).forEach((reset) => reset()); });

async function renderWall(node: ReactNode) {
  const { setup, root } = await tui.createRoot();
  await act(async () => root.render(node));
  await setup.renderOnce();
}

function arm(value: "control" | "teaser" | null | Promise<"control" | "teaser" | null>) {
  const exposure = spyOn(activity, "exposeWallTeaser").mockImplementation(async () => value);
  restore.push(() => exposure.mockRestore());
  return exposure;
}

// The pre-experiment wall is the visual baseline. A wrapper must not reserve
// preview space or alter the existing action scope while its answer is pending.
function OriginalWall({ needsVerification = false }: { needsVerification?: boolean }) {
  return <Box flexDirection="column" paddingX={1} paddingY={1} data-gloom-ui="sign-in-wall">
    <EmptyState title={needsVerification ? "Verify your email to read risk factors." : "Sign in to read risk factors."}
      actions={needsVerification ? <Button label="Resend Verification Email" onPress={() => {}} /> : <>
        <Button label="Log in" variant="primary" onPress={() => {}} />
        <Button label="Sign up free" variant="secondary" onPress={() => {}} />
      </>} />
  </Box>;
}

function Harness({ original = false, placement = "risk-signin", height = 20, needsVerification = false }: {
  original?: boolean; placement?: string; height?: number; needsVerification?: boolean;
}) {
  const state = createInitialState(createTestPaneConfig(join(homedir(), ".cache/gloom-smoke/glo239/sign-in-wall-test"), {
    instanceId: "wall", paneId: "risk-factors",
  }));
  state.focusedPaneId = "wall";
  return <TestPaneFrame state={state} paneId="wall" pluginId="wall" runtime={createTestPluginRuntime({ openCommandBar })}
    width={84} height={height} footerKeys>
    {(body) => original ? <OriginalWall needsVerification={needsVerification} /> : <SignInWall
      placement={placement} width={84} height={body.height} symbol="AAPL" exchange="US"
      action="read risk factors" needsVerification={needsVerification} />}
  </TestPaneFrame>;
}

test.each([{ state: "control", value: "control" }, { state: "stopped", value: null }] as const)("pending and $state sign-in walls preserve the original frame", async ({ value }) => {
  await renderWall(<Harness original />);
  const original = await tui.waitForFrameToContain("Sign up free");
  const answer = Promise.withResolvers<"control" | null>();
  const exposure = arm(answer.promise);
  await renderWall(<Harness />);
  await tui.waitForFrameToContain("Sign up free");
  expect(tui.frame()).toBe(original);
  expect(exposure).toHaveBeenCalledWith("wall_teaser_signin");
  await act(async () => answer.resolve(value));
  await tui.renderFrames(2);
  expect(tui.frame()).toBe(original);
  expect(activity.recordWallViewed).toHaveBeenCalledWith("risk-signin", undefined);
});

test("a sign-in sample preserves keyboard and mouse auth actions and their placement", async () => {
  arm("teaser");
  await renderWall(<Harness placement="flow-signin" />);
  await tui.waitForFrameToContain("Sample");
  await tui.emitKeypress({ name: "return" });
  expect(activity.recordWallCtaClicked).toHaveBeenLastCalledWith("flow-signin", "login");
  expect(authDialog.requestAuthDialog).toHaveBeenLastCalledWith({ mode: "login" });
  await tui.clickFrameText("Sign up free");
  expect(activity.recordWallCtaClicked).toHaveBeenLastCalledWith("flow-signin", "signup");
  expect(authDialog.requestAuthDialog).toHaveBeenLastCalledWith({ mode: "signup" });
  expect(openCommandBar).not.toHaveBeenCalled();
  spyOn(authDialog, "requestAuthDialog").mockReturnValue(false);
  await tui.clickFrameText("Log in");
  expect(openCommandBar).toHaveBeenLastCalledWith("Log In");
  expect(activity.recordWallViewed).toHaveBeenCalledWith("flow-signin", "sample");
});

test("sign-in summary requests use the existing catalog id and retain the sign-in view id", async () => {
  arm("teaser");
  const summary = spyOn(wallSummary, "getWallSummary").mockResolvedValue({ kind: "counts", items: [
    { label: "risk_count", value: 31 }, { label: "filed_at", value: "2025-10-31" },
  ] });
  restore.push(() => summary.mockRestore());
  await renderWall(<Harness />);
  await tui.waitForFrameToContain("2025-10-31");
  expect(summary).toHaveBeenCalledWith("risk-wall", "AAPL", "US");
  expect(activity.recordWallViewed).toHaveBeenCalledWith("risk-signin", "summary");
  expect(tui.frame()).not.toContain("Sample");
});

test("walls outside the catalog count without enrolling or requesting a summary", async () => {
  const exposure = arm("teaser");
  const summary = spyOn(wallSummary, "getWallSummary").mockResolvedValue(null);
  restore.push(() => summary.mockRestore());
  await renderWall(<Harness original />);
  const original = await tui.waitForFrameToContain("Sign up free");
  await renderWall(<Harness placement="account-signin" />);
  await tui.renderFrames(2);
  expect(tui.frame()).toBe(original);
  expect(exposure).not.toHaveBeenCalled();
  expect(summary).not.toHaveBeenCalled();
  expect(activity.recordWallViewed).toHaveBeenCalledWith("account-signin", undefined);
});

test("a short sign-in wall retains the original frame and reports no teaser", async () => {
  arm("teaser");
  const summary = spyOn(wallSummary, "getWallSummary").mockResolvedValue(null);
  restore.push(() => summary.mockRestore());
  await renderWall(<Harness height={7} original />);
  const original = await tui.waitForFrameToContain("Sign up free");
  await renderWall(<Harness height={7} />);
  await tui.renderFrames(2);
  expect(tui.frame()).toBe(original);
  expect(summary).not.toHaveBeenCalled();
  expect(activity.recordWallViewed).toHaveBeenCalledWith("risk-signin", "none");
});

test("the verification wall keeps its resend action without reporting an auth CTA", async () => {
  arm(null);
  spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "unverified", plan: "free", emailVerified: false } as AuthUser);
  await renderWall(<Harness original needsVerification />);
  const original = await tui.waitForFrameToContain("Resend Verification Email");
  await renderWall(<Harness needsVerification />);
  await tui.renderFrames(2);
  expect(tui.frame()).toBe(original);
  await tui.emitKeypress({ name: "return" });
  expect(openCommandBar).toHaveBeenLastCalledWith("Resend Verification Email");
  expect(authDialog.requestAuthDialog).not.toHaveBeenCalled();
  expect(activity.recordWallCtaClicked).not.toHaveBeenCalled();
  expect(activity.recordWallViewed).toHaveBeenCalledWith("risk-signin", undefined);
});
