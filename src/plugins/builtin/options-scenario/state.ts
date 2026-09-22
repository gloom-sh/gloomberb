import { scenarioControlsFromSettings } from "./client";
import { buildScenario, optionExpirationClose, parseScenarioNumber, validateScenarioInputs,
  type ScenarioControls, type ScenarioPosition } from "./model";

export interface ScenarioInputFields {
  spot: string;
  rate: string;
  dividendYield: string;
  currency: string;
  asOf: string;
  spotRange: string;
}

/** Use the CLI's percentage units and strict UTC date parser for interactive input too. */
export function parseScenarioInputFields(
  position: ScenarioPosition, fields: ScenarioInputFields, controls: ScenarioControls | null,
): { position: ScenarioPosition; controls: ScenarioControls } {
  // These are required form fields even though their CLI flags are optional.
  const spotRange = parseScenarioNumber(fields.spotRange, "Spot range");
  if (!fields.asOf.trim()) throw new Error("Enter a valuation timestamp.");
  const origin = scenarioControlsFromSettings({ date: fields.asOf, spotRange }, position);
  const next: ScenarioPosition = { ...position, spot: parseScenarioNumber(fields.spot, "Spot"),
    rate: parseScenarioNumber(fields.rate, "Rate") / 100,
    dividendYield: parseScenarioNumber(fields.dividendYield, "Dividend yield") / 100,
    currency: fields.currency.trim().toUpperCase(), asOf: origin.date };
  const problem = validateScenarioInputs(next);
  if (problem) throw new Error(problem);
  const nextControls = scenarioControlsFromSettings({ date: controls?.date ?? origin.date,
    volShift: (controls?.volShift ?? 0) * 100, spotRange }, next);
  nextControls.date = Math.max(next.asOf, Math.min(nextControls.date, ...next.legs.map((leg) => optionExpirationClose(leg.expiration))));
  return { position: next, controls: nextControls };
}

export interface SavedScenarioStrategy {
  id: string;
  name: string;
  position: ScenarioPosition;
  controls: ScenarioControls;
}

/** A stable fallback also keeps useSyncExternalStore snapshots referentially stable. */
export const EMPTY_SAVED_STRATEGIES: SavedScenarioStrategy[] = [];

/** Restore independent snapshots; malformed entries cannot crash the saved-strategy picker. */
export function restoreSavedStrategies(input: unknown): { strategies: SavedScenarioStrategy[]; warnings: string[] } {
  if (!Array.isArray(input)) return { strategies: [], warnings: ["Saved strategies could not be read."] };
  const strategies: SavedScenarioStrategy[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of input.entries()) {
    try {
      if (!raw || typeof raw !== "object") throw new Error("invalid saved entry");
      const entry = raw as SavedScenarioStrategy;
      if (typeof entry.id !== "string" || !entry.id.trim() || typeof entry.name !== "string" || !entry.name.trim()) {
        throw new Error("missing strategy name or id");
      }
      if (ids.has(entry.id)) throw new Error("duplicate strategy id");
      if (!entry.controls || ["date", "volShift", "spotRange"].some((key) =>
        typeof entry.controls[key as keyof ScenarioControls] !== "number" || !Number.isFinite(entry.controls[key as keyof ScenarioControls]))) {
        throw new Error("invalid scenario controls");
      }
      const scenario = buildScenario(entry.position, entry.controls);
      strategies.push({ id: entry.id, name: entry.name.trim(),
        position: { ...scenario.position, legs: scenario.position.legs.map((leg) => ({ ...leg })) }, controls: { ...scenario.controls } });
      ids.add(entry.id);
    } catch (error) {
      warnings.push(`Saved strategy ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { strategies, warnings };
}
