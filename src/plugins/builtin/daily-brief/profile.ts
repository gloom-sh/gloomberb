import type { AppConfig } from "../../../types/config";

export interface BriefProfile {
  tickers: string[];
  commandIds: string[];
  paneIds: string[];
}

export function buildBriefProfile(config: AppConfig | null | undefined): BriefProfile {
  if (!config) return { tickers: [], commandIds: [], paneIds: [] };
  const panes = (config.layout?.instances ?? []).map((i) => i.paneId).filter(Boolean);
  return {
    tickers: [...(config.recentTickers ?? [])],
    commandIds: (config.recentCommands ?? []).map((c) => c.id),
    paneIds: panes,
  };
}

const BUILTIN_SECTIONS = ["headlines", "today", "earnings"] as const;
type Builtin = (typeof BUILTIN_SECTIONS)[number];

/**
 * Score how well each built-in brief table matches the user's recent activity.
 * Higher score => shown first. Ties keep the canonical order.
 */
export function scoreBriefSection(profile: BriefProfile, builtin: Builtin): number {
  const paneSet = new Set(profile.paneIds);
  const commandSet = new Set(profile.commandIds);
  const has = (id: string) => paneSet.has(id) || commandSet.has(id);
  let score = 0;
  if (builtin === "headlines") {
    if (has("news") || has("pane-template:news")) score += 3;
    if (profile.tickers.length > 0) score += 1;
  }
  if (builtin === "today") {
    if (has("macro-day") || has("release-calendar") || has("econ")) score += 3;
    if (has("central-bank-rates")) score += 2;
  }
  if (builtin === "earnings") {
    if (has("earnings") || has("earnings-calls")) score += 3;
    if (profile.tickers.length > 0) score += 1;
  }
  return score;
}

export function rankedBriefBuiltins(profile: BriefProfile): Builtin[] {
  return [...BUILTIN_SECTIONS].sort((a, b) => {
    const diff = scoreBriefSection(profile, b) - scoreBriefSection(profile, a);
    if (diff !== 0) return diff;
    return BUILTIN_SECTIONS.indexOf(a) - BUILTIN_SECTIONS.indexOf(b);
  });
}