import { expect, test } from "bun:test";
import { createDefaultConfig } from "../../../../types/config";
import { commitDesktopSnapshot, commitDesktopSnapshotInBackground, type DesktopSnapshotCommitHost } from "./snapshot-commit";
import { createDesktopWorkspace } from "./workspace";

function setup() {
  const workspace = createDesktopWorkspace(createDefaultConfig("/tmp/gloomberb-desktop-commit"), null);
  const steps: string[] = [];
  const settled = Promise.withResolvers<void>();
  const host: DesktopSnapshotCommitHost = {
    setConfig: () => { steps.push("config"); },
    replaceConfig: (config, options) => { workspace.replaceConfig(config, options); },
    currentSnapshot: () => workspace.getSnapshot(),
    saveConfig: async () => {
      steps.push("save");
      throw new Error("disk full");
    },
    reconcileWindows: () => { steps.push("reconcile"); },
    broadcastState: () => { steps.push("broadcast"); },
    sendWindowList: () => { steps.push("window list"); },
    reportSaveFailure: () => {
      steps.push("reported");
      settled.resolve();
    },
  };
  return { workspace, steps, settled: settled.promise, host };
}

test("a config that fails to save still reaches every window, and the request still fails", async () => {
  const { workspace, steps, host } = setup();
  await expect(commitDesktopSnapshot(host, workspace.getSnapshot())).rejects.toThrow("disk full");
  expect(steps).toEqual(["config", "save", "reconcile", "broadcast", "window list"]);
});

test("a change nobody waits on reports a failed save once the windows have it", async () => {
  const { workspace, steps, settled, host } = setup();
  commitDesktopSnapshotInBackground(host, workspace.getSnapshot(), { reconcileWindows: false });
  await settled;
  expect(steps).toEqual(["config", "save", "broadcast", "window list", "reported"]);
});
