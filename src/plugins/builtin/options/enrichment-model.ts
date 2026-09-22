import type { InstrumentRef } from "../../../market-data/request-types";
import type { QueryEntry } from "../../../market-data/result-types";
import { buildOptionsKey, resolveEntryData } from "../../../market-data/selectors";
import type { OptionsChain } from "../../../types/financials";
import { normalizeSymbol, parsePublicTickerKey } from "../../../utils/exchanges";
import { daysToExpiryFrom } from "../options-calculator/model";
import { volatilityTermSlope, type ExpectedMove } from "../shared/volatility";
import { buildSurfaceExpiry } from "../vol-surface/model";
import type { YieldPoint } from "../yield-curve/treasury-data";

export interface OptionsEnrichmentSelection {
  instrument: InstrumentRef;
  expiration: number;
  /** The selected entry already resolved by OMON, under this exact instrument and expiry. */
  selectedEntry: QueryEntry<OptionsChain>;
  /** Latest authoritative catalogue, including removals and empty responses. */
  catalogue: readonly number[];
  spot: number;
  spotAsOf?: string | number | null;
}

export interface OptionsEnrichmentSnapshot {
  key: string;
  expiration: number;
  phase: "loading" | "partial" | "ready" | "unavailable";
  expectedMove: ExpectedMove;
  /** Decimal IV difference: 25-delta put minus 25-delta call. */
  skew25: number | null;
  /** Decimal IV change per year to the immediately later listed expiry. */
  termSlope: number | null;
  neighbourExpiration: number | null;
  source: string | null;
  asOf: string | null;
  neighbourSource: string | null;
  neighbourAsOf: string | null;
  rateAsOf: string[];
  spot: number;
  spotAsOf: string | number | null;
  warnings: string[];
  error: string | null;
  fetchedAt: number;
}

export interface OptionsEnrichmentProjection extends OptionsEnrichmentSelection {
  curve?: readonly YieldPoint[];
  curveLoading?: boolean;
  treasuryError?: string | null;
  neighbourEntry?: QueryEntry<OptionsChain> | null;
  neighbourLoading?: boolean;
  neighbourError?: string | null;
  now: number;
}

function emptyExpectedMove(): ExpectedMove {
  return { straddle: null, straddlePercent: null, sigma: null, sigmaPercent: null, strike: null };
}

/** A missing adjacent quote is a gap, never permission to substitute a farther tenor. */
export function optionsEnrichmentNeighbour(catalogue: readonly number[], expiration: number, now: number): number | null {
  return [...new Set(catalogue)].filter((date) => Number.isFinite(date) && date > expiration && daysToExpiryFrom(date, now) > 0)
    .sort((left, right) => left - right)[0] ?? null;
}

function chainIssue(entry: QueryEntry<OptionsChain> | null | undefined, instrument: InstrumentRef, expiration: number, now: number): string | null {
  if (entry?.error) return entry.error.message;
  const chain = resolveEntryData(entry);
  if (!chain) return "Options chain unavailable";
  if (parsePublicTickerKey(normalizeSymbol(chain.underlyingSymbol)).symbol
    !== parsePublicTickerKey(normalizeSymbol(instrument.symbol)).symbol) {
    return `Options chain does not match underlying ${normalizeSymbol(instrument.symbol)}`;
  }
  if (entry?.staleAt != null && entry.staleAt <= now) return "Options chain is stale";
  if ([...chain.calls, ...chain.puts].some((contract) => contract.expiration !== expiration)) {
    return "Options chain does not match the selected expiration";
  }
  if (!chain.asOf || !Number.isFinite(Date.parse(chain.asOf))) return "Options chain observation date unavailable";
  return null;
}

export function optionsEnrichmentSelectionIssue(input: OptionsEnrichmentSelection, now: number): string | null {
  if (!input.catalogue.includes(input.expiration) || !(daysToExpiryFrom(input.expiration, now) > 0)) {
    return "Selected expiration unavailable";
  }
  if (!(input.spot > 0) || !Number.isFinite(input.spot)) return "Underlying quote unavailable";
  return chainIssue(input.selectedEntry, input.instrument, input.expiration, now);
}

/** Project snapshot quotes with the same cleaning, parity, fitting and pricer as OVDV. */
export function projectOptionsEnrichment(input: OptionsEnrichmentProjection): OptionsEnrichmentSnapshot {
  const chain = resolveEntryData(input.selectedEntry);
  const neighbourExpiration = optionsEnrichmentNeighbour(input.catalogue, input.expiration, input.now);
  const result: OptionsEnrichmentSnapshot = {
    key: buildOptionsKey({ instrument: input.instrument, expirationDate: input.expiration }),
    expiration: input.expiration, phase: "unavailable", expectedMove: emptyExpectedMove(), skew25: null, termSlope: null,
    neighbourExpiration, source: chain?.providerId ?? input.selectedEntry.source, asOf: chain?.asOf ?? null,
    neighbourSource: null, neighbourAsOf: null, rateAsOf: [], spot: input.spot, spotAsOf: input.spotAsOf ?? null,
    warnings: [], error: optionsEnrichmentSelectionIssue(input, input.now), fetchedAt: input.now,
  };
  if (result.error || !chain) return result;
  const selected = buildSurfaceExpiry({ chain, expiration: input.expiration, spot: input.spot,
    curve: input.curve ?? [], now: input.now, source: input.selectedEntry.source });
  result.expectedMove = selected.expectedMove;
  result.skew25 = selected.skew.putCallSkew;
  result.rateAsOf = [...selected.rateAsOf];
  result.warnings.push(...selected.warnings.filter((warning) => !(input.curveLoading && warning === "Treasury rate unavailable")));
  if (input.spotAsOf == null) result.warnings.push("Underlying quote observation date unavailable");
  if (selected.error) result.warnings.push(selected.error);
  const errors = input.treasuryError ? [`Treasury: ${input.treasuryError}`] : [];
  if (neighbourExpiration != null && !input.neighbourLoading) {
    const neighbourIssue = input.neighbourError ?? chainIssue(input.neighbourEntry, input.instrument, neighbourExpiration, input.now);
    const neighbourChain = resolveEntryData(input.neighbourEntry);
    result.neighbourSource = neighbourChain?.providerId ?? input.neighbourEntry?.source ?? null;
    result.neighbourAsOf = neighbourChain?.asOf ?? null;
    if (neighbourIssue) errors.push(`Adjacent expiry: ${neighbourIssue}`);
    else if (neighbourChain) {
      const neighbour = buildSurfaceExpiry({ chain: neighbourChain, expiration: neighbourExpiration, spot: input.spot,
        curve: input.curve ?? [], now: input.now, source: input.neighbourEntry?.source });
      result.rateAsOf = [...new Set([...result.rateAsOf, ...neighbour.rateAsOf])];
      result.warnings.push(...neighbour.warnings
        .filter((warning) => !(input.curveLoading && warning === "Treasury rate unavailable"))
        .map((warning) => `Adjacent expiry: ${warning}`));
      if (selected.atmIV != null && neighbour.atmIV != null) {
        result.termSlope = volatilityTermSlope({ years: selected.years, volatility: selected.atmIV },
          { years: neighbour.years, volatility: neighbour.atmIV });
        if (new Date(selected.asOf!).toISOString().slice(0, 10) !== new Date(neighbour.asOf!).toISOString().slice(0, 10)) {
          result.warnings.push("Term slope uses option observations from different dates");
        }
      }
    }
  }
  const loading = !!input.curveLoading || !!input.neighbourLoading;
  if (!loading) {
    if (result.expectedMove.straddle == null) result.warnings.push("ATM straddle move unavailable from cleaned quotes");
    if (result.expectedMove.sigma == null) result.warnings.push("Modeled expected move unavailable");
    if (result.skew25 == null) result.warnings.push("25-delta skew unavailable within observed strikes");
    if (neighbourExpiration != null && result.termSlope == null) result.warnings.push("Adjacent-expiry term slope unavailable");
  }
  result.error = errors.join("; ") || null;
  result.warnings = [...new Set(result.warnings)];
  const usable = result.expectedMove.straddle != null || result.expectedMove.sigma != null || result.skew25 != null;
  result.phase = loading ? usable ? "partial" : "loading"
    : !usable ? "unavailable" : result.error || result.warnings.length > 0 ? "partial" : "ready";
  return result;
}
