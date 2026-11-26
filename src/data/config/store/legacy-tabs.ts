export interface LegacyTab {
  index: number;
  name: string;
  panes: Set<string>;
}

type Match = { key: string; whole: boolean };

/**
 * Match both writers to the same baseline. Prefer unchanged names and pane instances; a rename can
 * follow its instances only when the match is unique in both directions. An empty rename can carry
 * selection/order, but not stale contents. Competing replacements share a vacancy, not pane edits.
 */
export function matchLegacyTabs(base: LegacyTab[], copy: LegacyTab[]): Map<number, Match> {
  const matches = new Map<number, Match>();
  const available = new Set(base);
  const pending = new Set(copy);
  const bind = (tab: LegacyTab, prior: LegacyTab, whole: boolean, key = `legacy:${prior.index}`) => {
    matches.set(tab.index, { key, whole });
    available.delete(prior);
    pending.delete(tab);
  };
  const unique = (compatible: (prior: LegacyTab, tab: LegacyTab) => boolean, whole = false) => {
    for (const tab of pending) {
      const candidates = [...available].filter((prior) => compatible(prior, tab));
      const prior = candidates[0];
      if (candidates.length !== 1 || !prior) continue;
      if (![...pending].some((other) => other !== tab && compatible(prior, other))) bind(tab, prior, whole);
    }
  };
  const sharesPane = (prior: LegacyTab, tab: LegacyTab) => [...tab.panes].some((id) => prior.panes.has(id));
  const samePanes = (prior: LegacyTab, tab: LegacyTab) => prior.panes.size === tab.panes.size && [...tab.panes].every((id) => prior.panes.has(id));
  unique((prior, tab) => prior.name === tab.name && samePanes(prior, tab));
  unique((prior, tab) => prior.name === tab.name && (!prior.panes.size || !tab.panes.size || sharesPane(prior, tab)));
  unique((prior, tab) => prior.panes.size > 0 && samePanes(prior, tab));
  unique(sharesPane);
  unique((prior, tab) => prior.index === tab.index && prior.name === tab.name && samePanes(prior, tab));
  unique((prior, tab) => !prior.panes.size && !tab.panes.size, true);

  const replace = (tab: LegacyTab, prior: LegacyTab) => bind(tab, prior, true, `replacement:${prior.index}`);
  for (const tab of pending) {
    const sameSlot = [...available].find((prior) => prior.index === tab.index);
    if (sameSlot) replace(tab, sameSlot);
  }
  for (const tab of pending) {
    const vacancy = available.values().next().value;
    if (vacancy) replace(tab, vacancy);
    else matches.set(tab.index, { key: `added:${tab.index}:${tab.name}`, whole: true });
  }
  return matches;
}
