import { afterEach, expect, test } from "bun:test";
import { act, useReducer, useRef } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { setUpdateHost, type ReleaseInfo, type UpdateProgress } from "../../updater";
import { VERSION } from "../../version";
import { useAppUpdateRuntime } from "./update";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setUpdateHost(null);
});

const release: ReleaseInfo = {
  version: "99.0.0",
  tagName: "v99.0.0",
  downloadUrl: "https://updates.example.test/stable-macos-arm64-update.json",
  publishedAt: "",
  updateAction: { kind: "desktop" },
};

interface FakeHost {
  checks: number;
  downloads: number;
  applies: number;
  /** What an apply reports once asked; the real one quits the app instead. */
  onApply: (report: (progress: UpdateProgress) => void) => void;
}

function installFakeHost(): FakeHost {
  const host: FakeHost = { checks: 0, downloads: 0, applies: 0, onApply: () => {} };
  setUpdateHost({
    async checkForUpdateDetailed() {
      host.checks += 1;
      return { kind: "available", release };
    },
    async performUpdate(_release, onProgress) {
      host.downloads += 1;
      onProgress({ phase: "downloading", percent: 50 });
      onProgress({ phase: "ready", canRestart: true });
    },
    async applyUpdate(onProgress) {
      host.applies += 1;
      host.onApply(onProgress);
    },
  });
  return host;
}

type Runtime = ReturnType<typeof useAppUpdateRuntime>;

async function mountRuntime(options: { detached?: boolean; initial?: Partial<AppState> } = {}) {
  let runtime!: Runtime;
  let current!: { state: AppState };
  const config = { ...createDefaultConfig("/tmp/gloomberb-update-runtime-test"), lastLaunchedVersion: VERSION };
  const stateRef: { current: AppState } = { current: { ...createInitialState(config), ...options.initial } };

  function Harness() {
    const [state, reactDispatch] = useReducer(appReducer, stateRef.current);
    // The app store reduces into the ref before React re-renders, so a second
    // call in the same tick already sees the first one's progress.
    const dispatch = useRef((action: AppAction) => {
      stateRef.current = appReducer(stateRef.current, action);
      reactDispatch(action);
    }).current;
    current = { state };
    runtime = useAppUpdateRuntime({
      dispatch,
      isDetachedWindow: options.detached ?? false,
      pluginRegistry: {} as never,
      stateRef,
      updateAvailable: state.updateAvailable,
      updateCheckInProgress: state.updateCheckInProgress,
      updateProgress: state.updateProgress,
    });
    return <text>harness</text>;
  }

  await tui.render(<Harness />, { width: 20, height: 2 });
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await tui.setup().renderOnce();
    });
  };
  await settle();
  return { runtime: () => runtime, state: () => current.state, settle };
}

test("downloads in the background, stops at ready, and restarts only when asked", async () => {
  const host = installFakeHost();
  const app = await mountRuntime();

  expect(app.state().updateProgress).toEqual({ phase: "ready", canRestart: true });
  expect(host).toMatchObject({ checks: 1, downloads: 1, applies: 0 });

  // The hourly check finds the staged update still there: no new check, no new
  // download, and the ready state stays.
  await act(async () => { await app.runtime().runUpdateCheck(false); });
  await app.settle();
  expect(host).toMatchObject({ checks: 1, downloads: 1, applies: 0 });
  expect(app.state().updateProgress).toEqual({ phase: "ready", canRestart: true });

  // Two clicks before anything answered: one apply.
  act(() => {
    app.runtime().restartToApplyUpdate();
    app.runtime().restartToApplyUpdate();
  });
  await app.settle();
  expect(host.applies).toBe(1);
  expect(app.state().updateProgress).toEqual({ phase: "replacing" });
});

test("a failed apply shows the error and can be tried again", async () => {
  const host = installFakeHost();
  host.onApply = (report) => report({ phase: "error", error: "Failed to replace app" });
  const app = await mountRuntime();

  act(() => { app.runtime().restartToApplyUpdate(); });
  await app.settle();
  expect(app.state().updateProgress).toEqual({ phase: "error", error: "Failed to replace app" });

  // Retry downloads again and lands on ready, then Restart works once more.
  act(() => { app.runtime().startUpdate(release); });
  await app.settle();
  expect(app.state().updateProgress).toEqual({ phase: "ready", canRestart: true });
  act(() => { app.runtime().restartToApplyUpdate(); });
  await app.settle();
  expect(host.applies).toBe(2);
});

test("a popped-out window neither checks nor restarts", async () => {
  const host = installFakeHost();
  const app = await mountRuntime({
    detached: true,
    initial: { updateProgress: { phase: "ready", canRestart: true } },
  });

  act(() => { app.runtime().restartToApplyUpdate(); });
  await app.settle();

  expect(host).toMatchObject({ checks: 0, downloads: 0, applies: 0 });
});
