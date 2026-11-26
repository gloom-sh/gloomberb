import { expect, test } from "bun:test";
import { diffSharedConfig } from "./shared-layout";

const pane = (instanceId: string) => ({ kind: "pane", instanceId });
const dock = (instanceId: string) => ({
  dockRoot: pane(instanceId), instances: [{ instanceId, paneId: instanceId }], floating: [], detached: [],
});

test("a stale split keeps its new pane, not a closed pane or an unplaced instance", () => {
  const help = dock("help");
  const indices = dock("world-indices");
  const hidden = { instanceId: "hidden-source", paneId: "portfolio-list" };
  const base = { ...help, instances: [...help.instances, hidden] };
  const opened = {
    ...base, instances: [...base.instances, ...indices.instances],
    dockRoot: { kind: "split", axis: "vertical", ratio: 0.5, first: help.dockRoot, second: indices.dockRoot },
  };
  const closed = { ...base, dockRoot: null, instances: [hidden] };
  const document = <Workspace>(layout: Workspace) => ({ activeLayoutIndex: 0, layout, layouts: [{ id: "home", layout: help }] });
  for (const [mine, theirs] of [[opened, closed], [closed, opened]] as const) {
    const result = diffSharedConfig(document(base), document(theirs)).apply(document(mine));
    expect(result.layout.dockRoot).toEqual(indices.dockRoot);
    expect(result.layout.instances.map((entry) => entry.instanceId).sort()).toEqual(["hidden-source", "world-indices"]);
    expect(result.layouts).toEqual(document(base).layouts);
  }
});

test("moving a pane out of a contested dock preserves its explicit placement", () => {
  const base = dock("help");
  const added = dock("econ-calendar");
  const opened = { ...base, instances: [...base.instances, ...added.instances], dockRoot: {
    kind: "split", axis: "vertical", ratio: 0.3, first: base.dockRoot, second: added.dockRoot,
  } };
  const floated = { ...base, dockRoot: null, floating: [{ instanceId: "help", x: 7, y: 4, width: 76, height: 23 }] };
  for (const [mine, theirs] of [[opened, floated], [floated, opened]] as const) {
    const { layout } = diffSharedConfig({ layout: base }, { layout: theirs }).apply({ layout: mine });
    expect(layout.dockRoot).toEqual(added.dockRoot);
    expect(layout.floating).toEqual(floated.floating);
  }
});

test("independent additions to different splits keep both writers' geometry", () => {
  const left = dock("help");
  const right = dock("news");
  const indices = dock("world-indices");
  const calendar = dock("econ-calendar");
  const root = { kind: "split", axis: "horizontal", ratio: 0.6, first: left.dockRoot, second: right.dockRoot };
  const base = { ...left, dockRoot: root, instances: [...left.instances, ...right.instances] };
  const first = { ...root, axis: "vertical", ratio: 0.3, first: indices.dockRoot, second: left.dockRoot };
  const second = { ...root, ratio: 0.7, first: right.dockRoot, second: calendar.dockRoot };
  const mine = { ...base, instances: [...base.instances, ...indices.instances], dockRoot: { ...root, first } };
  const theirs = { ...base, instances: [...base.instances, ...calendar.instances], dockRoot: { ...root, second } };
  const { layout } = diffSharedConfig({ layout: base }, { layout: theirs }).apply({ layout: mine });
  expect(layout.dockRoot).toEqual({ ...root, first, second });
});
