import { formatPercentileRank } from "../../../utils/format";

/**
 * "Was it a big day?": the size of a series' latest move against every move of
 * the same horizon in its history. GC gets its tenors' ranks from Gloom Cloud,
 * which holds the stored curves' whole history; ECST ranks the FRED history it
 * already loads, and `fred --change` prints the moves themselves.
 *
 * A move is an observation against the series' last one on or before the day
 * before (1D) or seven calendar days before (1W), within ten days, the way GC's
 * look-backs pick their sessions. A holiday is skipped; a longer gap (a tenor
 * Treasury stopped printing for years) is no move at all.
 */
export type MoveHorizon = "1D" | "1W";

export const MOVE_HORIZONS: readonly MoveHorizon[] = ["1D", "1W"];

/** How far before the day asked for the observation a move starts from may lie. */
const MOVE_WINDOW_DAYS = 10;
/** About a year of moves of its kind before a move's size is ranked. */
export const MOVE_RANK_MIN_OBSERVATIONS = 250;

const DAY_MS = 86_400_000;
const HORIZON_DAYS: Record<MoveHorizon, number> = { "1D": 1, "1W": 7 };

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);

/** Values print to a few decimals; this keeps 5.09 - 5.1 at -0.01, so equal moves tie. */
const clean = (value: number) => Math.round(value * 1e6) / 1e6;

export interface SeriesMove {
  /** The observation the move ends on. */
  date: string;
  /** The observation it is measured from. */
  from: string;
  /** In the series' own unit. */
  change: number;
}

type Observation = { date: string; value: number | null };

function observed(observations: readonly Observation[]): Array<{ date: string; value: number }> {
  return observations.filter((point): point is { date: string; value: number } => point.value != null && Number.isFinite(point.value));
}

/** Every move of a horizon, oldest first, from observations sorted oldest first; blank observations are skipped. */
export function seriesMoves(observations: readonly Observation[], horizon: MoveHorizon): SeriesMove[] {
  const points = observed(observations);
  const days = points.map((point) => dayNumber(point.date));
  const moves: SeriesMove[] = [];
  let base = 0;
  for (const [index, point] of points.entries()) {
    const target = days[index]! - HORIZON_DAYS[horizon];
    while (base + 1 < points.length && days[base + 1]! <= target) base += 1;
    if (days[base]! > target || days[base]! <= target - MOVE_WINDOW_DAYS) continue;
    const from = points[base]!;
    moves.push({ date: point.date, from: from.date, change: clean(point.value - from.value) });
  }
  return moves;
}

export interface MoveRank extends SeriesMove {
  horizon: MoveHorizon;
  /**
   * Midrank percentile of the move's size among the sizes of every move of its
   * horizon through it: the share smaller, ties counted half, 0 to 100. Null
   * with fewer than MOVE_RANK_MIN_OBSERVATIONS moves to rank against.
   */
  percentile: number | null;
  /** Moves ranked against, this one included. */
  observations: number;
  /** The date the oldest of them ends on. */
  since: string;
}

/** Midrank percentile of `size` among the sizes of `moves`, 0 to 100. */
function moveSizePercentile(moves: readonly SeriesMove[], size: number): number {
  const target = Math.abs(size);
  let rank = 0;
  for (const move of moves) {
    const other = Math.abs(move.change);
    rank += other < target ? 1 : other === target ? 0.5 : 0;
  }
  return moves.length ? (100 * rank) / moves.length : 0;
}

/** The move into the latest observation, ranked; null when that observation has no move. */
export function latestMoveRank(observations: readonly Observation[], horizon: MoveHorizon): MoveRank | null {
  const moves = seriesMoves(observations, horizon);
  const latest = moves.at(-1);
  if (!latest || latest.date !== observed(observations).at(-1)?.date) return null;
  return {
    ...latest,
    horizon,
    percentile: moves.length >= MOVE_RANK_MIN_OBSERVATIONS ? moveSizePercentile(moves, latest.change) : null,
    observations: moves.length,
    since: moves[0]!.date,
  };
}

/**
 * The rank as a figure's detail reads it: `21 pctl since 1962`, naming the
 * year the history it was ranked against starts. Null without a rank.
 */
export function formatMoveRank(rank: { percentile: number | null; since: string | null } | null | undefined): string | null {
  if (rank?.percentile == null || !rank.since) return null;
  return formatPercentileRank(rank.percentile, `since ${rank.since.slice(0, 4)}`);
}
