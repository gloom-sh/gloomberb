import { describe, expect, test } from "bun:test";
import type { LayoutConfig } from "../../types/config";
import { resolvePaneShowTarget } from "./layout-placement";

describe("resolvePaneShowTarget", () => {
  test("resolves a hidden pane by its exact instance id", () => {
    const hiddenPane = {
      instanceId: "news-top:stored",
      paneId: "news-top",
      binding: { kind: "none" as const },
      placementMemory: {
        floating: { x: 12, y: 4, width: 90, height: 30 },
      },
    };
    const layout: LayoutConfig = {
      dockRoot: null,
      instances: [hiddenPane],
      floating: [],
      detached: [],
    };

    expect(resolvePaneShowTarget(layout, hiddenPane.instanceId)).toEqual({
      paneType: "news-top",
      instance: hiddenPane,
    });
  });
});
