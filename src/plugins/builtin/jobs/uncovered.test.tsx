import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { act, useState } from "react";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { CloudJobsResponse } from "../../../api-client/types";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { resetJobsCache } from "./client";
import { JobsPane } from "./pane";

// Each request waits for the test to answer it.
const answers: Array<PromiseWithResolvers<CloudJobsResponse>> = [];
const spies = [
  spyOn(apiClient, "getCloudJobs").mockImplementation(() => {
    const answer = Promise.withResolvers<CloudJobsResponse>();
    answers.push(answer);
    return answer.promise;
  }),
  spyOn(apiClient, "getCurrentUser").mockReturnValue({ id: "pro", emailVerified: true, plan: "pro" } as never),
];
afterAll(() => { for (const spy of spies) spy.mockRestore(); });

const tui = createOpenTuiTestHarness();
afterEach(() => {
  answers.length = 0;
  resetJobsCache();
});

const uncovered = () => new ApiRequestError("No careers system found.", 404);

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await Bun.sleep(1); await tui.setup().renderOnce(); });
}

async function renderJobs(first: Error) {
  const id = "jobs:SIVE";
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-jobs-uncovered", { instanceId: id, paneId: "jobs", binding: { kind: "fixed", symbol: "SIVE" } }));
  state.tickers.set("SIVE", createTestTicker("SIVE", "Sivers Semiconductors"));
  const runtime = createTestPluginRuntime();
  function Harness() {
    const [paneState, setPaneState] = useState(state.paneState);
    state.paneState = paneState;
    // footerKeys: Enter reaches the button the way the app delivers it, through the pane footer.
    return <TestPaneFrame footerKeys width={90} height={12} state={state} dispatch={(action) => setPaneState(appReducer(state, action).paneState)} paneId={id} pluginId="jobs" runtime={runtime}>
      {(body) => <JobsPane width={body.width} height={body.height} focused />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 90, height: 12 }); });
  await settle();
  answers.shift()!.reject(first);
  await settle();
}

const pressEnter = () => tui.emitKeypress({ name: "return", sequence: "\r" }, { trackPropagation: true, frames: 2 });

// GLO-785: Enter asked again, the same 404 came back, and nothing on screen
// moved, so the press looked like it did nothing.
test("Look again answers Enter, says it is looking, then that the answer did not change", async () => {
  await renderJobs(uncovered());
  expect(await tui.waitForFrameToContain("No careers system found for SIVE.")).toContain("Look again  Enter");

  await pressEnter();
  await settle();
  expect(answers).toHaveLength(1);
  expect(tui.frame()).toContain("Looking again...  Enter");
  // A second press while it looks does not ask twice.
  await pressEnter();
  expect(answers).toHaveLength(1);

  answers.shift()!.reject(uncovered());
  const frame = await tui.waitForFrameToContain("Checked just now. Still no careers system.");
  expect(frame).toContain("Look again  Enter");
  expect(frame).not.toContain("Looking again...");
});

test("a failed load says it tried again once the same failure is back, though the spinner showed between", async () => {
  await renderJobs(new ApiRequestError("Service unavailable", 503));
  expect(await tui.waitForFrameToContain("Could not load hiring data.")).not.toContain("Tried again");

  await pressEnter();
  await tui.waitForFrameToContain("Loading SIVE hiring...");
  answers.shift()!.reject(new ApiRequestError("Service unavailable", 503));
  await tui.waitForFrameToContain("Tried again just now.");

  // An answer that changes the screen needs no line.
  await pressEnter();
  answers.shift()!.reject(uncovered());
  let frame = await tui.waitForFrameToContain("No careers system found for SIVE.");
  expect(frame).not.toContain("Tried again");
  expect(frame).not.toContain("Checked");

  // Nor does a look that failed: it shows the failure, not the old answer as if it were new.
  await pressEnter();
  answers.shift()!.reject(new ApiRequestError("Service unavailable", 503));
  frame = await tui.waitForFrameToContain("Could not load hiring data.");
  expect(frame).not.toContain("No careers system");
  expect(frame).not.toContain("Checked");
});
