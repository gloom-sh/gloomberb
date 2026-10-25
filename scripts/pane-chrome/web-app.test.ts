import { describe, expect, test } from "bun:test";
import { normalizePaneLayout } from "../../src/types/config";
import { fallbackInstance } from "./web-app";

describe("audit fallback layout", () => {
  test("retains ticker panes whose account-gated template declares no argument", () => {
    const instance = fallbackInstance({ token: "IBKR", paneId: "ibkr-trading", argKind: null });
    const layout = normalizePaneLayout({
      dockRoot: { kind: "pane", instanceId: instance.instanceId },
      instances: [instance],
      floating: [],
      detached: [],
    });

    expect(layout.instances).toEqual([instance]);
    expect(layout.dockRoot).toEqual({ kind: "pane", instanceId: instance.instanceId });
  });
});
