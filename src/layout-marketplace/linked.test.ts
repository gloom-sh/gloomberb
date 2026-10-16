import { expect, test } from "bun:test";
import type { LayoutConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import { layoutContentFingerprint, type CloudLayoutEntry } from "./cloud";
import { linkedLayoutStatus, originFromEntry, rehashedOrigin } from "./linked";

const workspace: PaneDef = {
  id: "commodities-energy", name: "Commodities & Energy", component: () => null, defaultPosition: "right",
  instanceTitle: (pane) => pane.params?.root ? `Curve \u00b7 ${pane.params.root}` : null,
};
const panes = new Map<string, PaneDef>([["commodities-energy", workspace]]);

function curveLayout(title: string): LayoutConfig {
  return {
    dockRoot: { kind: "pane", instanceId: "p1" },
    instances: [{ instanceId: "p1", paneId: "commodities-energy", title, params: { root: "BZ" }, settings: { workspaceTab: "curve" } }],
    floating: [],
    detached: [],
  };
}

test("a linked tab an older build hashed is hashed again from its revision, so the curve's new title is no edit", () => {
  // Published and linked by a build that titled the window "CTM BZ" and counted that title.
  const entry = {
    id: "a".repeat(32), name: "Curves", owner: { kind: "team", id: "org-1" }, revision: 4,
    layout: curveLayout("CTM BZ"), paneState: {},
  } as unknown as CloudLayoutEntry;
  const linked = { ...originFromEntry(entry, panes)!, contentHash: layoutContentFingerprint(entry) };
  // This build retitles the window when it opens.
  const opened = { layout: curveLayout("Curve \u00b7 BZ"), paneState: {}, origin: linked };
  expect(linkedLayoutStatus(opened, panes, 4)?.dirty).toBe(true);

  const rehashed = rehashedOrigin(linked, entry, panes)!;
  expect(rehashed).toEqual({ ...linked, contentHash: layoutContentFingerprint(entry, (paneId) => paneId === "commodities-energy") });
  expect(linkedLayoutStatus({ ...opened, origin: rehashed }, panes, 4)?.dirty).toBe(false);
  // Hashed alike already, or linked to another revision than the team's: nothing to redo.
  expect(rehashedOrigin(rehashed, entry, panes)).toBeNull();
  expect(rehashedOrigin({ ...linked, revision: 3 }, entry, panes)).toBeNull();
});
