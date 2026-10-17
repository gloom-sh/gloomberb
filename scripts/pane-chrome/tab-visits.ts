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
  /** The labels of its group, to tell a group a press revealed from one it relabelled. */
  groupLabels: string[];
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
  const entries = (scope, selector) => {
    const root = document.querySelector(scope);
    if (!root) return [];
    const groups = [];
    const members = new Map();
    for (const el of root.querySelectorAll(selector)) {
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
          groupLabels: labels,
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
    list(scope, selector) {
      return entries(scope, selector).map(({ el, place, ...entry }) => entry);
    },
    /** Scrolls the alternative into view and says where a press lands on it, or why it cannot. */
    aim(scope, selector, id) {
      const entry = entries(scope, selector).find((candidate) => candidate.id === id);
      if (!entry) return { error: "not on the page" };
      if (entry.disabled) return { error: "disabled" };
      if (entry.hidden) return { error: "not laid out" };
      // Marked, so the press is checked on this very element even when its group's labels change with it.
      for (const marked of document.querySelectorAll("[data-tab-visit-target]")) marked.removeAttribute("data-tab-visit-target");
      entry.el.setAttribute("data-tab-visit-target", "");
      entry.el.scrollIntoView({ block: "nearest", inline: "center" });
      return { ok: true, place: entry.place, label: entry.label };
    },
    point(scope, selector, id) {
      const entry = entries(scope, selector).find((candidate) => candidate.id === id);
      if (!entry) return { error: "not on the page" };
      const rect = entry.el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { error: "outside the window after scrolling into view" };
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === entry.el || entry.el.contains(hit))) return { error: "covered by " + (hit?.getAttribute?.("data-gloom-role") || hit?.tagName?.toLowerCase() || "nothing") };
      return { x, y };
    },
    /** The pressed alternative: the marked element, or (re-rendered) the one with its identity, or its label in its place. */
    selected(scope, selector, id, place, label) {
      const all = entries(scope, selector);
      const marked = document.querySelector("[data-tab-visit-target]");
      // A choice may relabel itself once chosen ("Auto" reads "Auto (5m)").
      const entry = all.find((candidate) => candidate.el === marked)
        ?? all.find((candidate) => candidate.id === id)
        ?? all.find((candidate) => candidate.place === place && (candidate.label === label || candidate.label.startsWith(label + " ")));
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
async function listAlternatives(cdp: Cdp, scope: string, selector: string): Promise<Alternative[]> {
  await helpers(cdp);
  return evaluate<Alternative[]>(cdp, `window.__tabVisits.list(${JSON.stringify(scope)}, ${JSON.stringify(selector)})`);
}

/**
 * Presses one alternative and confirms the page selected it; the error says
 * why it did not. `settle` waits for what the press loads.
 */
async function selectAlternative(cdp: Cdp, scope: string, selector: string, id: string, settle: () => Promise<void>): Promise<{ ok: true } | { ok: false; reason: string }> {
  await helpers(cdp);
  const aim = () => evaluate<{ ok?: true; place?: string; label?: string; error?: string }>(cdp, `window.__tabVisits.aim(${JSON.stringify(scope)}, ${JSON.stringify(selector)}, ${JSON.stringify(id)})`);
  let aimed = await aim();
  // What the press before revealed may arrive with its data (a chart's intervals once its bars load): wait for it twice more.
  for (let attempt = 0; aimed.error === "not on the page" && attempt < 2; attempt += 1) {
    await settle();
    await helpers(cdp);
    aimed = await aim();
  }
  if (aimed.error) return { ok: false, reason: aimed.error };
  await frames(cdp, 2);
  const at = await evaluate<{ x?: number; y?: number; error?: string }>(cdp, `window.__tabVisits.point(${JSON.stringify(scope)}, ${JSON.stringify(selector)}, ${JSON.stringify(id)})`);
  if (at.error || at.x === undefined || at.y === undefined) return { ok: false, reason: at.error ?? "no point to press" };
  await click(cdp, { x: at.x, y: at.y });
  await settle();
  await helpers(cdp);
  const selected = await evaluate<{ ok?: true; error?: string }>(cdp, `window.__tabVisits.selected(${JSON.stringify(scope)}, ${JSON.stringify(selector)}, ${JSON.stringify(id)}, ${JSON.stringify(aimed.place)}, ${JSON.stringify(aimed.label)})`);
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
  /** What counts as an alternative: tabs and choices by default, `[role=tab]` for tabs alone. */
  selector?: string;
}

/**
 * Opens every view the pane's alternatives lead to (see the top of this file)
 * and returns one entry per alternative: measured, unmeasured with the reason,
 * or skipped (disabled, not laid out, deeper than `depth`). The pane as it
 * first shows is the caller's to measure.
 */
export async function visitAlternatives({ cdp, scope, reset, settle, record, depth = 2, selector = "[role=tab], [role=radio]" }: VisitOptions): Promise<TabVisit[]> {
  const visits: TabVisit[] = [];
  await reset();
  const first = await listAlternatives(cdp, scope, selector);
  const queue: Array<{ path: Alternative[]; parent: Alternative[] }> = [];
  const enqueue = (path: Alternative[], alternatives: Alternative[], parent: Alternative[]) => {
    for (const alternative of alternatives) {
      if (alternative.selected) continue;
      const next = [...path, alternative];
      const named = next.map(({ id, name }) => ({ id, name }));
      if (alternative.disabled) visits.push({ path: named, status: "skipped", reason: "disabled" });
      else if (alternative.hidden) visits.push({ path: named, status: "skipped", reason: "not laid out (inside a view that is not open, or hidden at this size)" });
      else if (next.length > depth) visits.push({ path: named, status: "skipped", reason: `revealed ${next.length} presses deep; the sweep opens ${depth}` });
      else queue.push({ path: next, parent });
    }
  };
  enqueue([], first, []);
  for (let index = 0; index < queue.length; index += 1) {
    const { path } = queue[index]!;
    const named = path.map(({ id, name }) => ({ id, name }));
    await reset();
    let failure: string | null = null;
    for (const [step, alternative] of path.entries()) {
      const result = await selectAlternative(cdp, scope, selector, alternative.id, settle);
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
    // What this press revealed: alternatives in a group the state before it did not have, or new in one it had.
    const stateBefore = path.length > 1 ? queue[index]!.parent : first;
    const now = await listAlternatives(cdp, scope, selector);
    enqueue(path, now.filter((entry) => isRevealed(entry, stateBefore)), now);
  }
  // An alternative not laid out at first (inside a view not yet open) that a press then revealed and the sweep measured is covered, not skipped.
  const reached = new Set(visits.filter((visit) => visit.status === "measured").map((visit) => visit.path.at(-1)!.id));
  return visits.filter((visit) => !(visit.status === "skipped" && visit.reason?.startsWith("not laid out") && reached.has(visit.path.at(-1)!.id)));
}

/** The label without what a choice adds once chosen ("Auto (5m)" is "Auto"). */
function baseLabel(label: string): string {
  return label.replace(/\s+\(.*\)$/, "");
}

/**
 * Whether a press revealed `entry`: no group laid out before it shares half
 * its labels (a relabelled or re-chosen group is the same group), or the
 * group that does lacked this label.
 */
function isRevealed(entry: Alternative, before: Alternative[]): boolean {
  if (entry.hidden) return false;
  const labels = new Set(entry.groupLabels.map(baseLabel));
  let best: Set<string> | null = null, bestScore = 0;
  // Only what was laid out before: a group mounted but hidden then is revealed by the press that shows it.
  for (const group of new Set(before.filter((alternative) => !alternative.hidden).map((alternative) => alternative.groupLabels.map(baseLabel).join("|")))) {
    const other = new Set(group.split("|"));
    const shared = [...labels].filter((label) => other.has(label)).length;
    const score = shared / new Set([...labels, ...other]).size;
    if (score > bestScore) { bestScore = score; best = other; }
  }
  return bestScore < 0.5 || !best!.has(baseLabel(entry.label));
}

/** A view's name from its path: "Positioning > Disaggregated". */
export function pathName(path: Array<{ name: string }>): string {
  return path.map((entry) => entry.name).join(" > ");
}
