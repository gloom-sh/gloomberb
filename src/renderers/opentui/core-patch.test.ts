import { afterEach, expect, test } from "bun:test";
import { BoxRenderable, RGBA, ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";

// Behaviour of the local @opentui/core patch (patches/@opentui%2Fcore@0.3.2.patch).

let current: TestRendererSetup | null = null;
afterEach(() => {
  current?.renderer.destroy();
  current = null;
});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface LayoutState {
  _x: number;
  _y: number;
  _widthValue: number;
  _heightValue: number;
  _lastLayoutFrame: number;
  _childrenInLayoutOrder: Renderable[];
  yogaNode: { getComputedLayout(): { left: number; top: number; width: number; height: number } };
}

/** Each node the last frame walked whose box is not the one yoga holds for it. */
function staleBoxes(root: Renderable, frameId: number): string[] {
  const stale: string[] = [];
  const visit = (node: Renderable) => {
    const state = node as unknown as LayoutState;
    if (state._lastLayoutFrame === frameId) {
      const layout = state.yogaNode.getComputedLayout();
      const expected = [
        layout.left,
        layout.top,
        Math.max(layout.width, 1),
        Math.max(layout.height, 1),
      ];
      const actual = [state._x, state._y, state._widthValue, state._heightValue];
      if (actual.some((value, index) => !Object.is(value, expected[index]))) {
        stale.push(`${node.id}: ${actual.join(",")} != ${expected.join(",")}`);
      }
    }
    for (const child of state._childrenInLayoutOrder) visit(child);
  };
  visit(root);
  return stale;
}

// The core reads a node's layout from yoga only when yoga laid the node out
// again since the last read. Whatever changes between frames, every node a
// frame walks must hold the box yoga computed for it. Each seed reaches a case
// the others do not, a node read out of order among them.
for (const seed of [8, 18, 39]) test(`after any change, each node a frame draws has the box yoga laid out for it (seed ${seed})`, async () => {
  current = await createTestRenderer({ width: 60, height: 24 });
  const { renderer, renderOnce } = current;
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
  let serial = 0;

  const boxes: BoxRenderable[] = [];
  const texts: TextRenderable[] = [];
  const addBox = (parent: Renderable) => {
    const box = new BoxRenderable(renderer, {
      id: `box-${serial++}`,
      flexDirection: random() < 0.5 ? "row" : "column",
      flexGrow: random() < 0.4 ? 1 : 0,
      ...(random() < 0.3 ? { width: 2 + Math.floor(random() * 20) } : {}),
      ...(random() < 0.3 ? { height: 1 + Math.floor(random() * 6) } : {}),
    });
    parent.add(box);
    boxes.push(box);
    return box;
  };
  const addText = (parent: Renderable) => {
    const text = new TextRenderable(renderer, { id: `text-${serial++}`, content: "x".repeat(1 + Math.floor(random() * 12)) });
    parent.add(text);
    texts.push(text);
  };

  const top = addBox(renderer.root);
  top.flexGrow = 1;
  const scroll = new ScrollBoxRenderable(renderer, { id: "scroll", height: 8 });
  top.add(scroll);
  for (let index = 0; index < 12; index += 1) {
    const row = addBox(scroll);
    row.height = 1 + Math.floor(random() * 2);
    addText(row);
  }
  for (let index = 0; index < 24; index += 1) {
    const parent = pick(boxes)!;
    if (random() < 0.5) addBox(parent);
    else addText(parent);
  }

  const live = <T extends Renderable>(nodes: T[]) => nodes.filter((node) => !node.isDestroyed && node.parent);
  // The top box always stays, so there is always a box to pick.
  const box = (): BoxRenderable => pick(live(boxes)) ?? top;
  const changes: Array<() => void> = [
    () => { const text = pick(live(texts)); if (text) text.content = "y".repeat(1 + Math.floor(random() * 30)); },
    () => { box().width = random() < 0.3 ? "auto" : 1 + Math.floor(random() * 30); },
    () => { box().height = random() < 0.3 ? "auto" : 1 + Math.floor(random() * 8); },
    () => { box().flexGrow = random() < 0.5 ? 0 : 1; },
    () => { box().flexDirection = random() < 0.5 ? "row" : "column"; },
    () => { box().paddingLeft = Math.floor(random() * 3); },
    () => { box().marginTop = Math.floor(random() * 2); },
    () => { const target = box(); if (target !== top) target.visible = !target.visible; },
    () => { if (random() < 0.5) addBox(box()); else addText(box()); },
    () => {
      const node: Renderable | undefined = random() < 0.5 ? pick(live(texts)) : box();
      if (node && node !== top && live(boxes).length > 4) node.destroyRecursively();
    },
    () => {
      // Moves a node under a box outside its own subtree.
      const node = box();
      const target = box();
      let ancestor: Renderable | null = target;
      while (ancestor && ancestor !== node) ancestor = ancestor.parent;
      if (node !== top && !ancestor) target.add(node);
    },
    () => { scroll.scrollTo({ x: 0, y: Math.floor(random() * 20) }); },
    () => {
      const target = box();
      if (target === top) return;
      target.position = random() < 0.5 ? "absolute" : "relative";
      target.left = Math.floor(random() * 10);
      target.top = Math.floor(random() * 5);
    },
  ];

  await renderOnce();
  expect(staleBoxes(renderer.root, renderer.frameId)).toEqual([]);
  for (let step = 0; step < 400; step += 1) {
    const count = 1 + Math.floor(random() * 3);
    for (let index = 0; index < count; index += 1) pick(changes)();
    await renderOnce();
    expect({ step, stale: staleBoxes(renderer.root, renderer.frameId) }).toEqual({ step, stale: [] });
  }
});

test("a box takes the fill of the hovered box it sits in, and gives it back when the pointer leaves", async () => {
  current = await createTestRenderer({ width: 20, height: 6 });
  const { renderer } = current;
  const outer = new BoxRenderable(renderer, { id: "outer", width: 10, height: 4, hoverBackgroundColor: "#336699" } as ConstructorParameters<typeof BoxRenderable>[1]);
  const inner = new BoxRenderable(renderer, { id: "inner", width: 4, height: 2 });
  const beside = new BoxRenderable(renderer, { id: "beside", width: 4, height: 2 });
  renderer.root.add(outer);
  outer.add(inner);
  renderer.root.add(beside);
  type Hoverable = BoxRenderable & { getActiveHoverBackgroundColor(): RGBA | undefined; processMouseEvent(event: { type: string }): void };
  const hex = (box: BoxRenderable) => (box as Hoverable).getActiveHoverBackgroundColor()?.toString();
  const fill = RGBA.fromHex("#336699").toString();

  expect(hex(inner)).toBeUndefined();
  // The pointer reaches the inner box first and the event rises to the outer one.
  (inner as Hoverable).processMouseEvent({ type: "over" });
  expect([hex(outer), hex(inner), hex(beside)]).toEqual([fill, fill, undefined]);
  (inner as Hoverable).processMouseEvent({ type: "out" });
  expect([hex(outer), hex(inner)]).toEqual([undefined, undefined]);
});
