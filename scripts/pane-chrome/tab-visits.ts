import { click, evaluate, frames, type Cdp } from "./browser";

/**
 * Every view a pane's tabs and choices lead to, each one opened for real.
 *
 * An alternative is anything with `role="tab"` or `role="radio"` in the pane
 * (its title bar too): tab strips, sub-tabs, segmented choices and the query
 * bar's views. Each has an identity that survives a reload and repeated
 * labels: its group (the tablist or radiogroup, named by the labels in it,
 * and which of the groups with those labels it is) and its place in the group.
 *
 * Each one is opened from the pane as it first shows (the caller's `reset`):
 * scrolled into view inside an overflowing strip, pressed where the pointer
 * would press it, and only counted once the page says it is the selected one
 * (`aria-selected` or `aria-checked`). A switch that did not happen is
 * reported as unmeasured with the reason; it is never recorded as the view it
 * asked for. What a switch reveals (a sub-tab strip, a query bar's views) is
 * opened the same way, one level down by default; anything deeper is counted
 * as not explored. Nothing is capped or dropped silently: disabled and hidden
 * alternatives are listed as skipped, with why.
 */

export interface Alternative {
  /** Stable across reloads: group signature, which of the groups with it, place in the group. */
  id: string;
  label: string;
  /** The label, told apart from another alternative with the same label in the same state. */
  name: string;
  selected: boolean;
  /** The page says whether it is selected (aria-selected or aria-checked). */
  hasState: boolean;
  disabled: boolean;
  /** Not laid out: inside a view that is not open, or hidden at this size. */
  hidden: boolean;
}

type TabVisitStatus = "measured" | "unmeasured" | "skipped";

export interface TabVisit {
  /** The alternatives pressed, in order, from the pane as it first shows. */
  path: Array<{ id: string; name: string }>;
  status: TabVisitStatus;
  reason?: string;
}

const HELPERS = `(() => {
  if (window.__tabVisits) return;
  const groupOf = (el) => el.closest("[role=tablist], [role=radiogroup]") ?? el.parentElement;
  const labelOf = (el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim();
  const entries = (scope) => {
    const root = document.querySelector(scope);
    if (!root) return [];
    const groups = [];
    const members = new Map();
    for (const el of root.querySelectorAll("[role=tab], [role=radio]")) {
      const group = groupOf(el);
      if (!members.has(group)) { members.set(group, []); groups.push(group); }
      members.get(group).push(el);
    }
    const seen = new Map();
    const out = [];
    groups.forEach((group, groupIndex) => {
      const list = members.get(group);
      const labels = list.map(labelOf);
      const signature = (group.getAttribute?.("aria-label") || "") + "[" + labels.join("|") + "]";
      const occurrence = seen.get(signature) ?? 0;
      seen.set(signature, occurrence + 1);
      list.forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        out.push({
          el,
          id: signature + "#" + occurrence + "/" + index,
          label: labels[index],
          place: (groupIndex + 1) + "." + (index + 1),
          selected: el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true",
          hasState: el.hasAttribute("aria-selected") || el.hasAttribute("aria-checked"),
          disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
          hidden: rect.width === 0 || rect.height === 0 || style.visibility === "hidden",
        });
      });
    });
    const counts = new Map();
    for (const entry of out) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
    for (const entry of out) entry.name = counts.get(entry.label) > 1 ? entry.label + " [" + entry.place + "]" : entry.label;
    return out;
  };
  window.__tabVisits = {
    list(scope) {
      return entries(scope).map(({ el, place, ...entry }) => entry);
    },
    /** Scrolls the alternative into view and says where a press lands on it, or why it cannot. */
    aim(scope, id) {
      const entry = entries(scope).find((candidate) => candidate.id === id);
      if (!entry) return { error: "not on the page" };
      if (entry.disabled) return { error: "disabled" };
      if (entry.hidden) return { error: "not laid out" };
      entry.el.scrollIntoView({ block: "nearest", inline: "center" });
      return { ok: true };
    },
    point(scope, id) {
      const entry = entries(scope).find((candidate) => candidate.id === id);
      if (!entry) return { error: "not on the page" };
      const rect = entry.el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { error: "outside the window after scrolling into view" };
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === entry.el || entry.el.contains(hit))) return { error: "covered by " + (hit?.getAttribute?.("data-gloom-role") || hit?.tagName?.toLowerCase() || "nothing") };
      return { x, y };
    },
    selected(scope, id) {
      const entry = entries(scope).find((candidate) => candidate.id === id);
      if (!entry) return { error: "gone after the press" };
      if (!entry.hasState) return { error: "the page does not say which one is selected" };
      return entry.selected ? { ok: true } : { error: "not selected after the press" };
    },
  };
})()`;

async function helpers(cdp: Cdp): Promise<void> {
  await evaluate(cdp, HELPERS);
}

/** The alternatives in the pane as it is now. */
async function listAlternatives(cdp: Cdp, scope: string): Promise<Alternative[]> {
  await helpers(cdp);
  return evaluate<Alternative[]>(cdp, `window.__tabVisits.list(${JSON.stringify(scope)})`);
}

/**
 * Presses one alternative and confirms the page selected it; the error says
 * why it did not. `settle` waits for what the press loads.
 */
async function selectAlternative(cdp: Cdp, scope: string, id: string, settle: () => Promise<void>): Promise<{ ok: true } | { ok: false; reason: string }> {
  await helpers(cdp);
  const aimed = await evaluate<{ ok?: true; error?: string }>(cdp, `window.__tabVisits.aim(${JSON.stringify(scope)}, ${JSON.stringify(id)})`);
  if (aimed.error) return { ok: false, reason: aimed.error };
  await frames(cdp, 2);
  const at = await evaluate<{ x?: number; y?: number; error?: string }>(cdp, `window.__tabVisits.point(${JSON.stringify(scope)}, ${JSON.stringify(id)})`);
  if (at.error || at.x === undefined || at.y === undefined) return { ok: false, reason: at.error ?? "no point to press" };
  await click(cdp, { x: at.x, y: at.y });
  await settle();
  await helpers(cdp);
  const selected = await evaluate<{ ok?: true; error?: string }>(cdp, `window.__tabVisits.selected(${JSON.stringify(scope)}, ${JSON.stringify(id)})`);
  return selected.error ? { ok: false, reason: selected.error } : { ok: true };
}

export interface VisitOptions {
  cdp: Cdp;
  scope: string;
  /** Back to the pane as it first shows (a fresh layout). */
  reset(): Promise<void>;
  settle(): Promise<void>;
  /** Measures the view reached by `path`, which the page has confirmed selected; false when there was nothing to measure. */
  record(path: Alternative[]): Promise<boolean>;
  /** Presses in a row from the first view; what a deeper press reveals is counted, not opened. */
  depth?: number;
}

/**
 * Opens every view the pane's alternatives lead to (see the top of this file)
 * and returns one entry per alternative: measured, unmeasured with the reason,
 * or skipped (disabled, not laid out, deeper than `depth`). The pane as it
 * first shows is the caller's to measure.
 */
export async function visitAlternatives({ cdp, scope, reset, settle, record, depth = 2 }: VisitOptions): Promise<TabVisit[]> {
  const visits: TabVisit[] = [];
  await reset();
  const first = await listAlternatives(cdp, scope);
  const queue: Array<{ path: Alternative[]; known: Set<string> }> = [];
  const known = new Set(first.map((entry) => entry.id));
  const enqueue = (path: Alternative[], alternatives: Alternative[], parentKnown: Set<string>) => {
    for (const alternative of alternatives) {
      if (parentKnown.has(alternative.id) && path.length > 0) continue;
      if (alternative.selected) continue;
      const next = [...path, alternative];
      const named = next.map(({ id, name }) => ({ id, name }));
      if (alternative.disabled) visits.push({ path: named, status: "skipped", reason: "disabled" });
      else if (alternative.hidden) visits.push({ path: named, status: "skipped", reason: "not laid out (inside a view that is not open, or hidden at this size)" });
      else if (next.length > depth) visits.push({ path: named, status: "skipped", reason: `revealed ${next.length} presses deep; the sweep opens ${depth}` });
      else queue.push({ path: next, known: new Set([...parentKnown, ...alternatives.map((entry) => entry.id)]) });
    }
  };
  enqueue([], first, known);
  for (let index = 0; index < queue.length; index += 1) {
    const { path, known: before } = queue[index]!;
    const named = path.map(({ id, name }) => ({ id, name }));
    await reset();
    let failure: string | null = null;
    for (const [step, alternative] of path.entries()) {
      const result = await selectAlternative(cdp, scope, alternative.id, settle);
      if (!result.ok) {
        failure = path.length > 1 ? `press ${step + 1} of ${path.length} (${alternative.name}): ${result.reason}` : result.reason;
        break;
      }
    }
    if (failure) {
      visits.push({ path: named, status: "unmeasured", reason: failure });
      continue;
    }
    if (!await record(path)) {
      visits.push({ path: named, status: "unmeasured", reason: "selected, but the pane was not there to measure" });
      continue;
    }
    visits.push({ path: named, status: "measured" });
    const revealed = (await listAlternatives(cdp, scope)).filter((entry) => !before.has(entry.id));
    enqueue(path, revealed, before);
  }
  return visits;
}

/** A view's name from its path: "Positioning > Disaggregated". */
export function pathName(path: Array<{ name: string }>): string {
  return path.map((entry) => entry.name).join(" > ");
}
