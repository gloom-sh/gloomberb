import { describe, expect, test } from "bun:test";
import { getDockedPaneIds } from "../../../layout/pane-manager";
import { createPaneInstance, type LayoutConfig } from "../../../types/config";
import { resolveShellVisibleLayout } from "./visible-layout";

describe("shell visible layout", () => {
  test("removes unregistered pane types before resolving dock geometry", () => {
    const layout: LayoutConfig = {
      dockRoot: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "missing:main" },
        second: { kind: "pane", instanceId: "chat:main" },
      },
      instances: [
        createPaneInstance("missing-plugin", { instanceId: "missing:main" }),
        createPaneInstance("chat", { instanceId: "chat:main" }),
      ],
      floating: [],
      detached: [],
    };

    const visibleLayout = resolveShellVisibleLayout(
      layout,
      new Set(),
      new Map([["chat", true]]),
    );

    expect(visibleLayout.instances.map((instance) => instance.instanceId)).toEqual(["chat:main"]);
    expect(getDockedPaneIds(visibleLayout)).toEqual(["chat:main"]);
  });
});
