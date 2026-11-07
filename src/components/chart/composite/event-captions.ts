import type { CompositeChartEvent } from "./types";

/** A caption never sits further than this many cells from its guide. */
const NEAR_CELLS = 2;

/** An event in view, with the plot columns its guide (or its period) covers. */
export interface EventCaptionAnchor {
  event: CompositeChartEvent;
  from: number;
  to: number;
}

/** A caption laid out in the row under the axis. */
export interface EventCaptionPlacement {
  id: string;
  left: number;
  text: string;
}

interface Group {
  events: CompositeChartEvent[];
  from: number;
  to: number;
  captions: readonly string[];
  /** The caption shown: an index into `captions`, longest first. */
  level: number;
}

interface Placed {
  group: Group;
  left: number;
}

/**
 * Where a caption goes: centred on its guide, inside the plot, ending at
 * `limit` at the latest, and never more than two cells from its guide; null
 * when it cannot.
 */
function captionLeft(group: Group, text: string, width: number, limit: number): number | null {
  const length = text.length;
  if (length === 0 || length > width) return null;
  const centred = Math.round((group.from + group.to) / 2 - (length - 1) / 2);
  const left = Math.min(Math.max(0, Math.min(width - length, centred)), limit - length + 1);
  if (left < 0) return null;
  const right = left + length - 1;
  const gap = group.to < left ? left - group.to : group.from > right ? group.from - right : 0;
  return gap <= NEAR_CELLS ? left : null;
}

/** The longest caption of `group` from its level on that fits before `limit`. */
function fit(group: Group, width: number, limit: number): Placed | null {
  for (let level = group.level; level < group.captions.length; level += 1) {
    const left = captionLeft(group, group.captions[level]!, width, limit);
    if (left !== null) return { group: { ...group, level }, left };
  }
  return null;
}

/**
 * The events' captions in one row, newest first so the latest keeps the most
 * room. Each is the longest of its captions that fits beside its guide; when
 * two collide, the older one takes a shorter caption, then the newer one
 * does, then the two share one caption (`merge`), and without one, or with
 * no room even for that, the older is left out. A caption is never moved away
 * from its guide to find room.
 */
export function layoutEventCaptions(
  anchors: readonly EventCaptionAnchor[],
  width: number,
  merge?: (events: readonly CompositeChartEvent[]) => readonly string[],
): EventCaptionPlacement[] {
  const groups = anchors
    .filter((anchor) => anchor.event.captions?.length)
    .map((anchor): Group => ({ events: [anchor.event], from: anchor.from, to: anchor.to, captions: anchor.event.captions!, level: 0 }))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const placed: Placed[] = [];
  // The last column free for a caption left of those placed, a blank cell between two.
  const limit = () => (placed.length > 0 ? placed.at(-1)!.left - 2 : width - 1);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    for (;;) {
      const own = fit(group, width, limit());
      if (own) {
        placed.push(own);
        break;
      }
      const right = placed.at(-1);
      if (!right) break;
      if (right.group.level < right.group.captions.length - 1) {
        placed.pop();
        const shorter = fit({ ...right.group, level: right.group.level + 1 }, width, limit());
        placed.push(shorter ?? right);
        if (shorter) continue;
      }
      if (merge) {
        placed.pop();
        const events = [...group.events, ...right.group.events];
        const shared = fit({ events, from: group.from, to: Math.max(group.to, right.group.to), captions: merge(events), level: 0 }, width, limit());
        placed.push(shared ?? right);
      }
      break;
    }
  }
  return placed.reverse().map(({ group, left }) => ({
    id: group.events.map((event) => event.id).join("+"),
    left,
    text: group.captions[group.level]!,
  }));
}
