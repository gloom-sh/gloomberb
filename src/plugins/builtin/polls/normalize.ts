import type {
  PollAverageSummary,
  PollRow,
  PollTrendPoint,
  PollsterAverage,
  VoteHubPoll,
  VoteHubPollAnswer,
} from "./types";

const POLL_TYPE_LABELS: Record<string, string> = {
  approval: "Approval",
  favorability: "Favorability",
  "generic-ballot": "Generic",
  "us-senator": "Senate",
  governor: "Governor",
  "us-representative": "House",
  mayor: "Mayor",
  "attorney-general": "AG",
  "presidential-primary": "Primary",
  "proposition-50": "Prop",
};

/** Readable sample populations; "A"/"RV"/"LV" meant nothing without a legend. */
const POPULATION_LABELS: Record<string, string> = {
  a: "Adults",
  rv: "Reg",
  lv: "Likely",
};

export function pollTypeLabel(pollType: string): string {
  return POLL_TYPE_LABELS[pollType] ?? pollType.replace(/-/g, " ");
}

export function populationLabel(population: string | null | undefined): string {
  if (!population) return "—";
  return POPULATION_LABELS[population.toLowerCase()] ?? population.toUpperCase();
}

export function parseSampleSize(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Approximate 95% confidence margin of error for a proportion at 50/50,
 * derived from sample size: MoE ≈ 0.98 / sqrt(n).
 * Returns null when sample size is missing or too small to be meaningful.
 */
export function computeMarginOfError(sampleSize: number | null): number | null {
  if (sampleSize == null || sampleSize < 1) return null;
  const moe = (0.98 / Math.sqrt(sampleSize)) * 100;
  return Number.isFinite(moe) ? Math.round(moe * 10) / 10 : null;
}

export function formatPollDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function sortedAnswers(answers: VoteHubPollAnswer[] | undefined): VoteHubPollAnswer[] {
  return [...(answers ?? [])]
    .filter((answer) => typeof answer.choice === "string" && Number.isFinite(answer.pct))
    .sort((left, right) => right.pct - left.pct);
}

export function summarizeAnswers(answers: VoteHubPollAnswer[] | undefined): {
  result: string;
  lead: number | null;
  leadChoice: string | null;
} {
  const ranked = sortedAnswers(answers);
  const first = ranked[0];
  const second = ranked[1];
  if (!first) return { result: "—", lead: null, leadChoice: null };
  if (!second) {
    return {
      result: `${shortChoice(first.choice)} ${formatPct(first.pct)}`,
      lead: first.pct,
      leadChoice: first.choice,
    };
  }
  const lead = first.pct - second.pct;
  return {
    result: `${shortChoice(first.choice)} ${formatPct(first.pct)}  ${shortChoice(second.choice)} ${formatPct(second.pct)}`,
    lead,
    leadChoice: first.choice,
  };
}

function shortChoice(choice: string): string {
  const trimmed = choice.trim();
  if (trimmed.length <= 10) return trimmed;
  return trimmed.slice(0, 9);
}

function formatPct(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function normalizeVoteHubPoll(poll: VoteHubPoll): PollRow {
  const summary = summarizeAnswers(poll.answers);
  const sampleSize = parseSampleSize(poll.sample_size);
  return {
    id: poll.id,
    subject: poll.subject,
    pollType: poll.poll_type,
    pollTypeLabel: pollTypeLabel(poll.poll_type),
    pollster: poll.pollster,
    population: populationLabel(poll.population),
    sampleSize,
    marginOfError: computeMarginOfError(sampleSize),
    startDate: poll.start_date,
    endDate: poll.end_date,
    result: summary.result,
    lead: summary.lead,
    leadChoice: summary.leadChoice,
    url: poll.url,
    sponsors: Array.isArray(poll.sponsors) ? poll.sponsors.filter((sponsor) => typeof sponsor === "string") : [],
    partisan: typeof poll.partisan === "string" ? poll.partisan : null,
    internal: poll.internal === true,
    answers: sortedAnswers(poll.answers),
  };
}

export type PollSortColumnId = "date" | "subject" | "pollster" | "pop" | "result";

export interface PollSortPreference {
  columnId: PollSortColumnId;
  direction: "asc" | "desc";
}

export const DEFAULT_POLL_SORT: PollSortPreference = { columnId: "date", direction: "desc" };

export function comparePollRows(
  left: PollRow,
  right: PollRow,
  columnId: PollSortColumnId,
): number {
  switch (columnId) {
    case "date":
      return dateValue(left.endDate ?? left.startDate) - dateValue(right.endDate ?? right.startDate);
    case "subject":
      return left.subject.localeCompare(right.subject);
    case "pollster":
      return left.pollster.localeCompare(right.pollster);
    case "pop":
      return left.population.localeCompare(right.population);
    case "result":
      return (left.lead ?? Number.NEGATIVE_INFINITY) - (right.lead ?? Number.NEGATIVE_INFINITY);
  }
}

export function sortPollRows(
  rows: PollRow[],
  preference: PollSortPreference = DEFAULT_POLL_SORT,
): PollRow[] {
  const sign = preference.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const primary = comparePollRows(left, right, preference.columnId);
    if (primary !== 0) return sign * primary;
    return left.subject.localeCompare(right.subject);
  });
}

function dateValue(value: string | null): number {
  if (!value) return 0;
  const time = new Date(`${value}T00:00:00Z`).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Case-insensitive substring filter across subject, pollster, and seat name.
 * Returns the original array when the query is empty.
 */
export function filterPollRows(rows: PollRow[], query: string): PollRow[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return rows;
  return rows.filter((row) =>
    row.subject.toLowerCase().includes(trimmed) ||
    row.pollster.toLowerCase().includes(trimmed) ||
    row.pollTypeLabel.toLowerCase().includes(trimmed),
  );
}

/**
 * Collect a time series of percentage values for a specific choice across all
 * polls sharing the same subject. Points are sorted chronologically by end date.
 */
export function computePollTrend(
  rows: PollRow[],
  subject: string,
  choice: string,
): PollTrendPoint[] {
  const target = choice.toLowerCase();
  const points: PollTrendPoint[] = [];
  for (const row of rows) {
    if (row.subject !== subject) continue;
    const answer = row.answers.find((a) => a.choice.toLowerCase() === target);
    if (!answer) continue;
    const date = row.endDate ?? row.startDate;
    if (!date) continue;
    points.push({ date, value: answer.pct, pollster: row.pollster });
  }
  return points.sort((a, b) => dateValue(a.date) - dateValue(b.date));
}

/**
 * Simple moving average over a sorted trend series. Each output point is the
 * mean of the current and preceding `window - 1` values. Returns an empty
 * array when there are fewer than `window` points.
 */
export function computeMovingAverage(
  points: PollTrendPoint[],
  window: number,
): Array<{ date: string; value: number }> {
  if (window < 1 || points.length < window) return [];
  const result: Array<{ date: string; value: number }> = [];
  for (let i = window - 1; i < points.length; i++) {
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += points[j]!.value;
    }
    result.push({ date: points[i]!.date, value: sum / window });
  }
  return result;
}

/**
 * Group polls by pollster for a given subject and compute the sample-size-
 * weighted average of the leading choice's percentage, poll count, total
 * sample, and most recent end date. Sorted by poll count descending.
 */
export function computePollsterAverages(
  rows: PollRow[],
  subject: string,
  choice: string | null,
): PollsterAverage[] {
  const target = choice?.toLowerCase();
  const byPollster = new Map<string, { sum: number; weight: number; count: number; lastDate: string | null }>();
  for (const row of rows) {
    if (row.subject !== subject) continue;
    const answer = target
      ? row.answers.find((a) => a.choice.toLowerCase() === target)
      : row.answers[0];
    if (!answer) continue;
    const weight = row.sampleSize ?? 0;
    const entry = byPollster.get(row.pollster);
    if (entry) {
      entry.sum += answer.pct * weight;
      entry.weight += weight;
      entry.count += 1;
      const d = row.endDate ?? row.startDate;
      if (d && (!entry.lastDate || dateValue(d) > dateValue(entry.lastDate))) {
        entry.lastDate = d;
      }
    } else {
      byPollster.set(row.pollster, {
        sum: answer.pct * weight,
        weight,
        count: 1,
        lastDate: row.endDate ?? row.startDate,
      });
    }
  }
  return [...byPollster.entries()]
    .map(([pollster, entry]) => ({
      pollster,
      count: entry.count,
      avgPct: entry.weight > 0 ? entry.sum / entry.weight : entry.sum / entry.count,
      totalSample: entry.weight,
      lastDate: entry.lastDate,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Compute a sample-size-weighted average for each choice across recent polls
 * sharing a subject. `recentCount` limits to the most recent N polls by end
 * date. Returns summaries sorted by average percentage descending.
 */
export function computePollAverages(
  rows: PollRow[],
  subject: string,
  recentCount: number,
): PollAverageSummary[] {
  const matching = rows
    .filter((row) => row.subject === subject)
    .sort((a, b) => dateValue(b.endDate ?? b.startDate) - dateValue(a.endDate ?? a.startDate))
    .slice(0, Math.max(1, recentCount));

  const byChoice = new Map<string, { sum: number; weight: number; count: number }>();
  for (const row of matching) {
    for (const answer of row.answers) {
      const weight = row.sampleSize ?? 1;
      const entry = byChoice.get(answer.choice);
      if (entry) {
        entry.sum += answer.pct * weight;
        entry.weight += weight;
        entry.count += 1;
      } else {
        byChoice.set(answer.choice, { sum: answer.pct * weight, weight, count: 1 });
      }
    }
  }
  return [...byChoice.entries()]
    .map(([choice, entry]) => ({
      choice,
      avgPct: entry.weight > 0 ? entry.sum / entry.weight : entry.sum / entry.count,
      pollCount: entry.count,
      totalSample: entry.weight,
    }))
    .sort((a, b) => b.avgPct - a.avgPct);
}
