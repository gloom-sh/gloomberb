import { stableStringify } from "../utils/hash";
import type { AppConfig } from "../types/config";
import type { TickerPosition, TickerRecord } from "../types/ticker";
import { hydrateTickerMetadata } from "../tickers/metadata";
import { isFiniteNumber, isRecord } from "../utils/guards";
import { getBrokerInstance } from "../utils/broker-instances";
import {
  clearLeftoverBrokerHoldings,
  type KnownBrokerHoldings,
} from "../brokers/broker-portfolio-sync";
import type { LocalOnlyScope } from "./local-only";
import { mergeLocalBrokerPositionIdentity } from "./broker-identity";
import { sanitizePosition } from "./sanitize";
import { isSyncableTicker, sanitizeTickerMetadata } from "./ticker-payload";

export function lastSyncedTickersById(baselinePayload: unknown): Map<string, Record<string, unknown>> | null {
  if (!isRecord(baselinePayload) || !Array.isArray(baselinePayload.tickers)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of baselinePayload.tickers) {
    if (isRecord(entry) && typeof entry.ticker === "string") byId.set(entry.ticker, entry);
  }
  return byId;
}

/**
 * Compared as stored. What this device last synced is read back from storage
 * at launch without the fields that were undefined, so set against a copy
 * collected fresh as is, every ticker read as edited here: a device started
 * after a while away kept all its old rows and pushed them over newer ones.
 */
export function sameAsStored(left: unknown, right: unknown): boolean {
  const stored = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
  return stableStringify(stored(left)) === stableStringify(stored(right));
}

/**
 * A ticker's own fields. Quotes churn on every refresh, and which portfolios
 * hold it, and how much, merges portfolio by portfolio.
 */
function tickerOwnFields(metadata: Record<string, unknown>): Record<string, unknown> {
  const { quote: _quote, positions: _positions, portfolios: _portfolios, ...rest } = metadata;
  return rest;
}

/** One portfolio's part of a ticker: whether it lists the ticker, and the positions it holds in it. */
function holdingIn(positions: readonly TickerPosition[], links: readonly unknown[], portfolioId: string) {
  return {
    linked: links.includes(portfolioId),
    positions: positions.filter((position) => position.portfolio === portfolioId).map(sanitizePosition),
  };
}

/** Without a shared baseline, keep both devices' manual lots, matching identical copies one for one. */
function mergeUntrackedManualPositions(local: TickerPosition[], pulled: TickerPosition[]): TickerPosition[] {
  const unmatched = new Map<string, number>();
  for (const position of local) {
    const key = JSON.stringify(sanitizePosition(position));
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  const merged = [...local];
  for (const position of pulled) {
    const key = JSON.stringify(sanitizePosition(position));
    const count = unmatched.get(key) ?? 0;
    if (count > 0) unmatched.set(key, count - 1);
    else merged.push(position);
  }
  return merged;
}

export interface PulledTickersMerge {
  lastSyncedTickers: Map<string, Record<string, unknown>> | null;
  /** This device's live broker portfolios, each with the side holding its latest broker sync. */
  brokerPortfolios: ReadonlyMap<string, "local" | "pulled">;
  known: KnownBrokerHoldings;
  /** Connections kept on this device: their portfolios' holdings here outlast any pull. */
  localOnly: LocalOnlyScope | null;
}

/**
 * Which side holds the latest sync of each live broker portfolio. Its
 * positions are what the broker last reported, so only a later sync replaces
 * them: a pushed copy older than this device's (from a device that was away,
 * or an older build) never takes away positions this device's broker reported
 * since, whatever other portfolios hold on the same ticker.
 */
export function latestBrokerPortfolioSyncs(
  atPullStart: AppConfig,
  live: AppConfig,
  pulledPortfolios: unknown,
): Map<string, "local" | "pulled"> {
  const pulledSyncedAt = new Map<string, number>();
  for (const portfolio of Array.isArray(pulledPortfolios) ? pulledPortfolios : []) {
    if (isRecord(portfolio) && typeof portfolio.id === "string" && isFiniteNumber(portfolio.lastSyncedAt)) {
      pulledSyncedAt.set(portfolio.id, portfolio.lastSyncedAt);
    }
  }
  const sides = new Map<string, "local" | "pulled">();
  for (const portfolio of live.portfolios) {
    if (!getBrokerInstance(live.brokerInstances, portfolio.brokerInstanceId)) continue;
    const localSyncedAt = atPullStart.portfolios.find((entry) => entry.id === portfolio.id)?.lastSyncedAt;
    // Never synced here: its positions merge like a manual portfolio's.
    if (!isFiniteNumber(localSyncedAt)) continue;
    const pulled = pulledSyncedAt.get(portfolio.id);
    // Later than this device's copy, and than a sync here that ended while the pull was out.
    const pulledIsLater = pulled !== undefined
      && pulled > localSyncedAt
      && pulled >= (isFiniteNumber(portfolio.lastSyncedAt) ? portfolio.lastSyncedAt : 0);
    sides.set(portfolio.id, pulledIsLater ? "pulled" : "local");
  }
  return sides;
}

/**
 * A pulled ticker merged with this device's, portfolio by portfolio: this
 * device's part in a portfolio stays when it changed it since it last synced,
 * a live broker portfolio goes to the side with its latest sync, and the rest
 * comes from the pull. Broker contracts never sync and stay local.
 */
export function mergePulledTicker(
  current: TickerRecord | undefined,
  pulled: Record<string, unknown>,
  merge: PulledTickersMerge,
): TickerRecord {
  const local = current?.metadata;
  const baseline = merge.lastSyncedTickers?.get(String(pulled.ticker));
  // Nothing to compare with (no copy here, or this device never synced): the pull is taken.
  const comparable = !!local && !!merge.lastSyncedTickers;
  // No copy last synced means this device never uploaded the ticker: filed
  // locally it is unsynced work, unfiled it is not something sync tracks.
  const ownFieldsEdited = comparable && (baseline
    ? !sameAsStored(tickerOwnFields(sanitizeTickerMetadata(local)), tickerOwnFields(baseline))
    : isSyncableTicker(sanitizeTickerMetadata(local)));

  const localPositions = local?.positions ?? [];
  const localLinks = local?.portfolios ?? [];
  const pulledPositions = Array.isArray(pulled.positions)
    ? mergeLocalBrokerPositionIdentity(localPositions, pulled.positions as TickerPosition[])
    : localPositions;
  const pulledLinks = Array.isArray(pulled.portfolios)
    ? pulled.portfolios.filter((portfolioId): portfolioId is string => typeof portfolioId === "string")
    : localLinks;
  const baselinePositions = Array.isArray(baseline?.positions) ? baseline.positions as TickerPosition[] : [];
  const baselineLinks = Array.isArray(baseline?.portfolios) ? baseline.portfolios : [];

  const portfolioIds = [...new Set([
    ...localLinks, ...localPositions.map((position) => position.portfolio),
    ...pulledLinks, ...pulledPositions.map((position) => position.portfolio),
  ])];
  const positions: TickerPosition[] = [];
  const portfolios: string[] = [];
  for (const portfolioId of portfolioIds) {
    const brokerSide = merge.brokerPortfolios.get(portfolioId);
    const takePulled = merge.localOnly?.portfolioIds.has(portfolioId) ? false : brokerSide
      ? brokerSide === "pulled"
      : !comparable || sameAsStored(
        holdingIn(localPositions, localLinks, portfolioId),
        holdingIn(baselinePositions, baselineLinks, portfolioId),
      );
    const [sidePositions, sideLinks] = takePulled ? [pulledPositions, pulledLinks] : [localPositions, localLinks];
    if (brokerSide && !merge.localOnly?.portfolioIds.has(portfolioId)) {
      // A broker's timestamp governs imported holdings, never hand-entered
      // lots. Those use the same edit comparison as a manual portfolio.
      const manualIn = (entries: readonly TickerPosition[]) => entries.filter((position) => (
        position.portfolio === portfolioId && position.broker === "manual"
      ));
      const localManual = manualIn(localPositions);
      const manualEdited = comparable && !sameAsStored(
        localManual.map(sanitizePosition), manualIn(baselinePositions).map(sanitizePosition),
      );
      const pulledManual = manualIn(pulledPositions);
      const manual = !comparable ? mergeUntrackedManualPositions(localManual, pulledManual)
        : manualEdited ? localManual : pulledManual;
      positions.push(...sidePositions.filter((position) => position.portfolio === portfolioId && position.broker !== "manual"), ...manual);
      if (sideLinks.includes(portfolioId) || manual.length > 0) portfolios.push(portfolioId);
    } else {
      positions.push(...sidePositions.filter((position) => position.portfolio === portfolioId));
      if (sideLinks.includes(portfolioId)) portfolios.push(portfolioId);
    }
  }

  const record: TickerRecord = {
    metadata: hydrateTickerMetadata({
      ...(ownFieldsEdited ? local : { ...local, ...pulled }),
      positions,
      portfolios,
      broker_contracts: local?.broker_contracts ?? [],
    }),
  };
  return clearLeftoverBrokerHoldings(record, merge.known) ?? record;
}

/**
 * A ticker the pull did not carry: without what removed broker profiles left,
 * and without positions in a broker portfolio whose later sync elsewhere no
 * longer reports the ticker. Null when nothing changes.
 */
export function withoutUnpulledHoldings(ticker: TickerRecord, merge: PulledTickersMerge): TickerRecord | null {
  const sold = (portfolioId: string) => merge.brokerPortfolios.get(portfolioId) === "pulled";
  const { metadata } = ticker;
  const positions = metadata.positions.filter((position) => position.broker === "manual" || !sold(position.portfolio));
  const held = new Set(positions.map((position) => position.portfolio));
  const portfolios = metadata.portfolios.filter((portfolioId) => held.has(portfolioId) || !sold(portfolioId));
  const kept = positions.length === metadata.positions.length && portfolios.length === metadata.portfolios.length
    ? ticker
    : { ...ticker, metadata: { ...metadata, positions, portfolios } };
  const cleaned = clearLeftoverBrokerHoldings(kept, merge.known) ?? kept;
  return cleaned === ticker ? null : cleaned;
}
