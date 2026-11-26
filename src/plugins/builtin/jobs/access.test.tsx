import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createInitialState } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { JobsPane } from "./pane";

const dom = createDomTestHarness();

afterEach(() => apiClient.setSessionToken(null));

test.each([false, true])("Hiring reports the real account gate (signed in: %s)", async (signedIn) => {
  apiClient.setSessionToken(signedIn ? "fixture-session" : null);
  if (signedIn) apiClient.restoreCachedUser({ id: "fixture", emailVerified: false, plan: "pro" } as never);
  const paneId = "jobs:access";
  const state = createInitialState(createTestPaneConfig("/unused", { instanceId: paneId, paneId: "jobs" }));
  const root = await dom.render(<TestPaneFrame state={state} paneId={paneId} pluginId="jobs" runtime={createTestPluginRuntime()} width={90} height={18}>
    {(body) => <JobsPane {...body} focused />}
  </TestPaneFrame>);
  const gate = root.querySelector('[data-gloom-ui="sign-in-wall"]');
  expect(gate?.getAttribute("data-gloom-sign-in")).toBe(signedIn ? "verify-email" : "pro");
  expect(gate?.textContent).toContain(signedIn ? "Verify your email" : "Gloom Cloud Pro: Sign in");
});
