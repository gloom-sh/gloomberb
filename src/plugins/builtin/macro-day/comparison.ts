import type { apiClient } from "../../../api-client";
import { fredSeriesArgument } from "../../../series/fred-argument";
import type { DataProvider } from "../../../types/data-provider";
import type { InstrumentRef } from "../../../market-data/request-types";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { loadMacroDayEarnings, loadMacroDayHistory, loadMacroDaySeriesHistory, macroDayEarningsNotice } from "./client";
import { macroDayMoveBasis, projectMacroDays, type MacroDayEvent, type MacroDayModel } from "./model";
import type { MacroReleaseList } from "./releases";

export const MAX_MACRO_DAY_SYMBOLS = 4;
export const MACRO_DAY_DAILY_BASIS = "Daily close-to-close; next available session if the release day did not trade.";
export const macroDayKey = ({ kind, date }: MacroDayEvent) => `${kind}:${date}`;

export async function loadMacroDayTarget(symbol: string, instrument: () => InstrumentRef | Promise<InstrumentRef>, options: {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  marketData?: DataProvider;
  apiClient?: Pick<typeof apiClient, "getCloudFredSeries">;
}) {
  const seriesId = fredSeriesArgument(symbol);
  if (seriesId) {
    const history = await loadMacroDaySeriesHistory({ ...options, seriesId }, options.apiClient);
    return { ...history, symbol, basis: history.rate ? "yield" as const : "return" as const, earnings: [], earningsNotice: null };
  }
  const target = await instrument();
  const request = { ...options, instrument: target };
  const [history, earnings] = await Promise.all([loadMacroDayHistory(request, options.marketData), loadMacroDayEarnings(request)]);
  return { ...history, symbol, basis: macroDayMoveBasis(parsePublicTickerKey(target.symbol).symbol), stale: history.stale || earnings.stale,
    earnings: earnings.reports, earningsNotice: macroDayEarningsNotice(earnings) };
}

export function projectMacroDayTargets(targets: readonly Awaited<ReturnType<typeof loadMacroDayTarget>>[], releases: MacroReleaseList, lookbackYears: number) {
  return targets.map(({ symbol, basis, history, earnings }) => projectMacroDays(history, {
    symbol, basis, releases: releases.releases, coveredThrough: releases.coveredThrough, earnings, lookbackYears,
  }));
}

export interface MacroDayComparisonRow extends MacroDayEvent {
  moves: ReadonlyMap<string, MacroDayEvent>;
}

export function compareMacroDays(models: readonly MacroDayModel[]): MacroDayComparisonRow[] {
  const days = new Map<string, MacroDayEvent & { moves: Map<string, MacroDayEvent> }>();
  for (const model of models) {
    for (const event of model.events) {
      const key = macroDayKey(event);
      let day = days.get(key);
      if (!day) {
        day = { ...event, session: event.date, earnings: false, moves: new Map() };
        days.set(key, day);
      }
      day.moves.set(model.symbol, event);
    }
  }
  return [...days.values()].sort((left, right) => right.date.localeCompare(left.date) || left.kind.localeCompare(right.kind));
}

export const macroDayComparisonHeader = (model: MacroDayModel) => `${model.symbol} ${model.basis === "yield" ? "bp" : "%"}`;
