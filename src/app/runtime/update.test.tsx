import { afterEach, describe, expect, test } from "bun:test";
import { act, useReducer, useRef } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { setUpdateHost, type ReleaseInfo, type UpdateProgress } from "../../updater";
import { resolveUpdateChannel, withUpdateChannel } from "../../updater/channel";
import { VERSION } from "../../version";
import { debugLog, type LogEntry } from "../../utils/debug-log";
import { useAppUpdateRuntime } from "./update";
import { setConfigStoreHost, type ConfigStoreHost } from "../../data/config/store";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setUpdateHost(null);
  setConfigStoreHost(null);
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
  let current!: { state: AppState; dispatch: (action: AppAction) => void };
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
    current = { state, dispatch };
    runtime = useAppUpdateRuntime({
      dispatch,
      isDetachedWindow: options.detached ?? false,
      pluginRegistry: {} as never,
      stateRef,
      updateAvailable: state.updateAvailable,
      updateChannel: resolveUpdateChannel(state.config, undefined),
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
  return { runtime: () => runtime, state: () => current.state, dispatch: (action: AppAction) => current.dispatch(action), settle };
}

test("a failed launch-version save is logged while the runtime keeps its config update", async () => {
  installFakeHost();
  const saved: unknown[] = [];
  setConfigStoreHost({
    saveConfig: async (config) => {
      saved.push(config);
      throw new Error("Injected config write failure");
    },
  } as ConfigStoreHost);
  const logged: LogEntry[] = [];
  const unsubscribe = debugLog.subscribe((entry) => { if (entry.source === "update") logged.push(entry); });
  try {
    const app = await mountRuntime({ initial: { config: createDefaultConfig("unused") } });
    expect(app.state().config.lastLaunchedVersion).toBe(VERSION);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ lastLaunchedVersion: VERSION });
    expect(logged.map((entry) => entry.source)).toEqual(["update"]);
  } finally {
    unsubscribe();
  }
});

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
  const logged: LogEntry[] = [];
  const unsubscribe = debugLog.subscribe((entry) => { if (entry.source === "update") logged.push(entry); });

  act(() => { app.runtime().restartToApplyUpdate(); });
  await app.settle();
  unsubscribe();
  expect(app.state().updateProgress).toEqual({ phase: "error", error: "Failed to replace app" });
  // The header cuts the message to its room; the log keeps all of it.
  expect(logged).toMatchObject([{ level: "error", message: "update failed", data: { error: "Failed to replace app" } }]);

  // Retry downloads again and lands on ready, then Restart works once more.
  act(() => { app.runtime().startUpdate(release); });
  await app.settle();
  expect(app.state().updateProgress).toEqual({ phase: "ready", canRestart: true });
  act(() => { app.runtime().restartToApplyUpdate(); });
  await app.settle();
  expect(host.applies).toBe(2);
});

/**
 * The check offers a release and its download then finds nothing to take: how
 * a nightly update ended before the download checked as the installed build.
 */
test("a download that finds nothing to take passes as a notice and is not offered again hourly", async () => {
  const host = { checks: 0, downloads: 0 };
  setUpdateHost({
    async checkForUpdateDetailed() {
      host.checks += 1;
      return { kind: "available", release };
    },
    async performUpdate(_release, onProgress) {
      host.downloads += 1;
      onProgress({ phase: "downloading", percent: 0 });
      onProgress({ phase: "done", message: "Already on the latest version" });
    },
  });
  const app = await mountRuntime();

  // A notice, which the header clears after its time like any other, and no
  // release left for the download to start from again.
  expect(app.state()).toMatchObject({ updateProgress: null, updateAvailable: null, updateNotice: "Already on the latest version" });
  expect(host).toEqual({ checks: 1, downloads: 1 });

  await act(async () => { await app.runtime().runUpdateCheck(false); });
  await app.settle();
  expect(host).toEqual({ checks: 2, downloads: 1 });
  expect(app.state().updateAvailable).toBeNull();

  // Asked by hand, it tries once more and answers the same.
  await act(async () => { await app.runtime().runUpdateCheck(true); });
  await app.settle();
  expect(host).toEqual({ checks: 3, downloads: 2 });
  expect(app.state()).toMatchObject({ updateProgress: null, updateAvailable: null, updateNotice: "Already on the latest version" });
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

test("switching channel checks the new one at once and says what it found", async () => {
  const checked: string[] = [];
  setUpdateHost({
    async checkForUpdateDetailed(_version, channel) {
      checked.push(channel);
      return channel === "stable"
        ? { kind: "current", notice: "Staying on v1.0.1-nightly.20261016.5.gabc until a newer stable release" }
        : { kind: "current" };
    },
    async performUpdate() {},
  });
  const app = await mountRuntime();
  expect(checked).toEqual(["stable"]);
  // The hourly check says nothing in the header.
  expect(app.state().updateNotice).toBeNull();

  act(() => { app.dispatch({ type: "SET_CONFIG", config: withUpdateChannel(app.state().config, "nightly") }); });
  await app.settle();
  expect(checked).toEqual(["stable", "nightly"]);
  expect(app.state().updateNotice).toBe(`Already on v${VERSION}`);

  act(() => { app.dispatch({ type: "SET_CONFIG", config: withUpdateChannel(app.state().config, "stable") }); });
  await app.settle();
  expect(checked).toEqual(["stable", "nightly", "stable"]);
  expect(app.state().updateNotice).toBe("Staying on v1.0.1-nightly.20261016.5.gabc until a newer stable release");
});

describe("a nightly build downloaded before the switch back to stable", () => {
  const nightly: ReleaseInfo = { ...release, version: "99.0.1-nightly.20261016.5.gabcdef0", tagName: "v99.0.1-nightly.20261016.5.gabcdef0", channel: "nightly" };

  /** Nightly offers a build, stable has nothing newer; downloads wait for `finish` when held. */
  function installChannelHost({ hold = false } = {}) {
    const host = { checked: [] as string[], finish: () => {} };
    setUpdateHost({
      async checkForUpdateDetailed(_version, channel) {
        host.checked.push(channel);
        return channel === "nightly" ? { kind: "available", release: nightly } : { kind: "current" };
      },
      async performUpdate(_release, onProgress) {
        onProgress({ phase: "downloading", percent: 10 });
        const ready = () => onProgress({ phase: "ready", canRestart: true });
        if (hold) host.finish = ready;
        else ready();
      },
      async applyUpdate() {},
    });
    return host;
  }

  async function switchTo(app: Awaited<ReturnType<typeof mountRuntime>>, channel: "stable" | "nightly") {
    act(() => { app.dispatch({ type: "SET_CONFIG", config: withUpdateChannel(app.state().config, channel) }); });
    await app.settle();
  }

  test("is taken back rather than installed by the restart, and stable checks again", async () => {
    const host = installChannelHost();
    const app = await mountRuntime();
    await switchTo(app, "nightly");
    await app.settle();
    expect(app.state().updateProgress).toEqual({ phase: "ready", canRestart: true });
    expect(app.state().updateAvailable?.version).toBe(nightly.version);

    await switchTo(app, "stable");
    await app.settle();
    expect(app.state().updateProgress).toBeNull();
    expect(app.state().updateAvailable).toBeNull();
    expect(host.checked).toEqual(["stable", "nightly", "stable"]);
    expect(app.state().updateNotice).toBe(`Already on v${VERSION}`);
  });

  test("is taken back when it only finishes downloading after the switch", async () => {
    const host = installChannelHost({ hold: true });
    const app = await mountRuntime();
    await switchTo(app, "nightly");
    expect(app.state().updateProgress).toEqual({ phase: "downloading", percent: 10 });

    await switchTo(app, "stable");
    // The download under way is left to finish.
    expect(app.state().updateProgress).toEqual({ phase: "downloading", percent: 10 });
    act(() => { host.finish(); });
    await app.settle();
    await app.settle();
    expect(app.state().updateProgress).toBeNull();
    expect(app.state().updateAvailable).toBeNull();
    expect(host.checked).toEqual(["stable", "nightly", "stable"]);
  });
});
