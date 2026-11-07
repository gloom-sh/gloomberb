import type { FloatingPaneEntry, LayoutConfig } from "../../types/config";
import { compactFloatingZ, maxFloatingZ } from "./floating";
import { detachPane, finalizeLayout } from "./layout-state";

/**
 * Floating windows stacked as tabs: the members share a `stack` key and one
 * rect, in the order the layout lists them, and the one in front (highest z,
 * the later one of equals) is the tab shown. Raising a member (a click on its
 * tab, focus) shows it; moving or resizing the stack moves every member
 * (`floatAtRect`). A key with one member left is dropped when the layout is
 * finalized.
 */

/** The members of the stack `instanceId` floats in, in tab order; empty when it floats alone. */
export function floatingStackMembers(floating: readonly FloatingPaneEntry[], instanceId: string): FloatingPaneEntry[] {
  const entry = floating.find((candidate) => candidate.instanceId === instanceId);
  if (!entry?.stack) return [];
  const members = floating.filter((candidate) => candidate.stack === entry.stack);
  return members.length > 1 ? members : [];
}

/** The member a stack shows: the one in front. */
function shownStackMember(members: readonly FloatingPaneEntry[]): FloatingPaneEntry | undefined {
  let shown: FloatingPaneEntry | undefined;
  for (const member of members) {
    if (!shown || (member.zIndex ?? 50) >= (shown.zIndex ?? 50)) shown = member;
  }
  return shown;
}

/**
 * Every floating stack, by the pane it shows, with its tabs in order. A list
 * sorted some other way (front to back) takes the layout's list as `order`.
 */
export function floatingStacks(
  floating: readonly FloatingPaneEntry[],
  order?: readonly { instanceId: string }[],
): Map<string, string[]> {
  const rank = order ? new Map(order.map((entry, index) => [entry.instanceId, index])) : null;
  const byKey = new Map<string, FloatingPaneEntry[]>();
  for (const entry of floating) {
    if (!entry.stack) continue;
    const members = byKey.get(entry.stack) ?? [];
    members.push(entry);
    byKey.set(entry.stack, members);
  }
  const stacks = new Map<string, string[]>();
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    const tabs = rank ? [...members].sort((a, b) => (rank.get(a.instanceId) ?? 0) - (rank.get(b.instanceId) ?? 0)) : members;
    stacks.set(shownStackMember(members)!.instanceId, tabs.map((member) => member.instanceId));
  }
  return stacks;
}

/**
 * Floating entries as a saved layout may hold them, made whole: a `stack`
 * key that is not a non-empty string, or that one entry alone has, is
 * dropped, and every member of a stack takes the rect of the tab it shows.
 * A client that does not know stacks keeps the key but draws each member as
 * a window of its own, so it may have moved them apart.
 */
export function alignFloatingStacks<T extends FloatingPaneEntry>(floating: readonly T[]): T[] {
  const byKey = new Map<string, T[]>();
  for (const entry of floating) {
    if (typeof entry.stack !== "string" || entry.stack.length === 0) continue;
    byKey.set(entry.stack, [...(byKey.get(entry.stack) ?? []), entry]);
  }
  const rects = new Map<string, Pick<FloatingPaneEntry, "x" | "y" | "width" | "height">>();
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    const { x, y, width, height } = shownStackMember(members)!;
    rects.set(key, { x, y, width, height });
  }
  return floating.map((entry) => {
    const rect = typeof entry.stack === "string" ? rects.get(entry.stack) : undefined;
    if (rect) return { ...entry, ...rect };
    if (!("stack" in entry)) return entry;
    const { stack: _stack, ...rest } = entry;
    return rest as T;
  });
}

/** The floating panes behind the tab their stack shows. */
export function hiddenFloatingTabIds(floating: readonly FloatingPaneEntry[]): Set<string> {
  const hidden = new Set<string>();
  for (const [shown, members] of floatingStacks(floating)) {
    for (const id of members) if (id !== shown) hidden.add(id);
  }
  return hidden;
}

/**
 * `draggedId` as the last tab of the floating window `targetId` (or its
 * stack), shown, at its rect. The dragged pane leaves wherever it was: the
 * dock, another stack, a floating spot of its own.
 */
export function stackFloatingOnto(layout: LayoutConfig, draggedId: string, targetId: string): LayoutConfig {
  if (draggedId === targetId) return layout;
  const target = layout.floating.find((entry) => entry.instanceId === targetId);
  if (!target) return layout;
  const key = target.stack ?? target.instanceId;
  const base = detachPane(layout, draggedId);
  const floating = base.floating.map((entry) => (entry.instanceId === targetId ? { ...entry, stack: key } : entry));
  floating.push({
    instanceId: draggedId,
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
    zIndex: maxFloatingZ(layout) + 1,
    stack: key,
  });
  return finalizeLayout({ ...base, floating: compactFloatingZ(floating) });
}

/** `instanceId` out of its floating stack, where it is, the others left as they are. */
export function unstackFloating(layout: LayoutConfig, instanceId: string): LayoutConfig {
  const entry = layout.floating.find((candidate) => candidate.instanceId === instanceId);
  if (!entry?.stack) return layout;
  return finalizeLayout({
    ...layout,
    floating: layout.floating.map((candidate) => {
      if (candidate.instanceId !== instanceId) return candidate;
      const { stack: _stack, ...rest } = candidate;
      return rest;
    }),
  });
}

export type FloatingSplitSide = "left" | "right" | "top" | "bottom";

/** The two halves of `rect` a split on `side` makes: the dropped window's, then the target's. */
export function floatingSplitRects(
  rect: { x: number; y: number; width: number; height: number },
  side: FloatingSplitSide,
): [{ x: number; y: number; width: number; height: number }, { x: number; y: number; width: number; height: number }] {
  const { x, y, width, height } = rect;
  if (side === "left" || side === "right") {
    const half = width / 2;
    const left = { x, y, width: half, height };
    const right = { x: x + half, y, width: width - half, height };
    return side === "left" ? [left, right] : [right, left];
  }
  const half = height / 2;
  const top = { x, y, width, height: half };
  const bottom = { x, y: y + half, width, height: height - half };
  return side === "top" ? [top, bottom] : [bottom, top];
}

/**
 * `draggedId` beside the floating window `targetId` on `side`, sharing its
 * rect: each takes half, edge to edge, so their shared edge resizes both.
 * The target's stack, if it is one, keeps its tabs and takes its half whole.
 */
export function splitFloating(layout: LayoutConfig, draggedId: string, targetId: string, side: FloatingSplitSide): LayoutConfig {
  if (draggedId === targetId) return layout;
  const target = layout.floating.find((entry) => entry.instanceId === targetId);
  if (!target) return layout;
  const [dropped, kept] = floatingSplitRects(target, side);
  const base = finalizeLayout(detachPane(layout, draggedId));
  const resized = finalizeLayout({
    ...base,
    floating: base.floating.map((entry) => (
      entry.instanceId === targetId || (target.stack && entry.stack === target.stack) ? { ...entry, ...kept } : entry
    )),
  });
  return finalizeLayout({
    ...resized,
    floating: compactFloatingZ([
      ...resized.floating,
      { instanceId: draggedId, ...dropped, zIndex: maxFloatingZ(resized) + 1 },
    ]),
  });
}
