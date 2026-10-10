import { TextAttributes } from "../../../ui";
import type { DataTableCell } from "../../../components";
import type { OptionContract, OptionsChain } from "../../../types/financials";
import { blendHex, colors } from "../../../theme/colors";
import { blendForContrast, blendForSeparation, contrastRatio } from "../../../theme/color-utils";
import { formatCompact } from "../../../utils/format";
import { formatOptionPrice, optionQuoteSide, optionSpread } from "./market-reference";
import { formatCarryPercent } from "./carry";
import type {
  OptionColumn,
  OptionFieldId,
  OptionTableRow,
} from "./types";
import type { OptionSide, OptionValuation } from "../shared/volatility";

type OptionColorRole = "call" | "put" | "price" | "activity" | "iv" | "strike";

type OptionFieldDef = {
  id: OptionFieldId;
  label: string;
  header: string;
  width: number;
  description: string;
};

const OPTION_TEXT_MIN_CONTRAST = 4.5;
// How far the in-the-money band stands off the out-of-the-money one. The two
// sit edge to edge across the strike column, so this is the step the eye
// actually reads, and holding it fixed is what makes the banding land the same
// way on every palette. Both sides share one neutral band: the call and put
// columns already carry their colour in the text, and a green and a red slab
// under it drowned the numbers. The step stays small enough that the selected
// row still stands clear of the band it sits in.
const MONEYNESS_MIN_SEPARATION = 1.25;
const MONEYNESS_MAX_TINT = 0.42;

export const OPTION_FIELD_DEFS: OptionFieldDef[] = [
  { id: "bid", label: "Bid", header: "BID", width: 7, description: "Best bid price." },
  { id: "ask", label: "Ask", header: "ASK", width: 7, description: "Best ask price." },
  { id: "spread", label: "Spread %", header: "SPRD%", width: 6, description: "Bid/ask width as a percent of the midpoint, the comparable liquidity read across strikes." },
  { id: "last", label: "Last", header: "LAST", width: 7, description: "Last traded price." },
  { id: "delta", label: "Delta", header: "Δ", width: 6, description: "Price sensitivity to a $1 move in the underlying." },
  { id: "gamma", label: "Gamma", header: "Γ", width: 7, description: "Delta sensitivity to a $1 move in the underlying." },
  { id: "theta", label: "Theta", header: "Θ", width: 7, description: "Estimated value decay per calendar day." },
  { id: "vega", label: "Vega", header: "VEGA", width: 7, description: "Price sensitivity to one volatility point." },
  { id: "rho", label: "Rho", header: "RHO", width: 7, description: "Price sensitivity to one interest-rate point." },
  { id: "iv", label: "Implied volatility", header: "IV", width: 6, description: "Volatility implied by the contract price." },
  { id: "volume", label: "Volume", header: "VOL", width: 6, description: "Contracts traded in the current session." },
  { id: "openInterest", label: "Open interest", header: "OI", width: 6, description: "Outstanding open contracts." },
  {
    id: "extrinsicPerYear",
    label: "Extrinsic per year",
    header: "EXT/Y",
    width: 7,
    description: "Time value (midpoint less intrinsic) as a percent of spot, divided by years to expiry: the yearly cost of holding the contract instead of the stock.",
  },
];

export const DEFAULT_OPTION_FIELD_IDS: OptionFieldId[] = ["bid", "ask", "last", "iv", "delta", "volume", "openInterest"];

const OPTION_FIELDS_BY_ID = new Map(OPTION_FIELD_DEFS.map((field) => [field.id, field]));

function optionFieldToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_%/-]+/g, "");
}

/** Each field by its id, label and header as typed, any case: `openInterest`, `oi`, `sprd%`, `ext/y`. */
const OPTION_FIELDS_BY_TOKEN = new Map(OPTION_FIELD_DEFS.flatMap((field) => [
  [optionFieldToken(field.id), field.id],
  [optionFieldToken(field.label), field.id],
  [optionFieldToken(field.header), field.id],
] as const));

/**
 * `fn OMON --columns bid,ask,spread,extrinsicPerYear`: the fields mirrored
 * around the strike, in order, as the pane setting stores them. An unknown
 * field fails, naming the ones there are.
 */
export function normalizeOptionColumnsOption(raw: string): string {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const unknown = tokens.filter((token) => !OPTION_FIELDS_BY_TOKEN.has(optionFieldToken(token)));
  if (tokens.length === 0 || unknown.length > 0) {
    throw new Error(`${unknown.length > 0 ? `Unknown option column ${unknown.join(", ")}` : "No option columns given"}. `
      + `Use: ${OPTION_FIELD_DEFS.map((field) => field.id).join(", ")}.`);
  }
  return resolveOptionFieldIds(tokens.map((token) => OPTION_FIELDS_BY_TOKEN.get(optionFieldToken(token))!)).join(",");
}

export function resolveOptionFieldIds(value: unknown): OptionFieldId[] {
  // A report's --columns arrives as the comma-separated text it was typed as.
  if (typeof value === "string") value = value.split(",");
  if (!Array.isArray(value)) return [...DEFAULT_OPTION_FIELD_IDS];
  const seen = new Set<OptionFieldId>();
  const fields = value.filter((id): id is OptionFieldId => {
    if (typeof id !== "string" || !OPTION_FIELDS_BY_ID.has(id as OptionFieldId) || seen.has(id as OptionFieldId)) {
      return false;
    }
    seen.add(id as OptionFieldId);
    return true;
  });
  return fields.length > 0 ? fields : [...DEFAULT_OPTION_FIELD_IDS];
}

function sideColumn(side: OptionSide, field: OptionFieldId): Omit<OptionColumn, "headerColor"> {
  const definition = OPTION_FIELDS_BY_ID.get(field)!;
  return {
    id: `${side}${field[0]!.toUpperCase()}${field.slice(1)}` as OptionColumn["id"],
    field,
    side,
    label: `${side === "call" ? "C" : "P"} ${definition.header}`,
    width: definition.width,
    align: "right",
  };
}

export function createOptionColumns(fieldIds: readonly OptionFieldId[]): Array<Omit<OptionColumn, "headerColor">> {
  const fields = resolveOptionFieldIds(fieldIds);
  return [
    ...fields.map((field) => sideColumn("call", field)),
    { id: "strike", field: "strike", side: null, label: "STRIKE", width: 9, align: "right" },
    ...[...fields].reverse().map((field) => sideColumn("put", field)),
  ];
}

export function buildStrikeList(chain: OptionsChain): number[] {
  const set = new Set<number>();
  for (const c of chain.calls) set.add(c.strike);
  for (const p of chain.puts) set.add(p.strike);
  return Array.from(set).sort((a, b) => a - b);
}

export function resolveDefaultStrikeTarget(
  optionStrike: number | undefined,
  quotePrice: number | undefined,
): number | null {
  if (optionStrike != null && Number.isFinite(optionStrike)) return optionStrike;
  if (quotePrice != null && Number.isFinite(quotePrice)) return quotePrice;
  return null;
}

export function findNearestStrikeIndex(strikes: number[], targetStrike: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < strikes.length; index += 1) {
    const distance = Math.abs(strikes[index]! - targetStrike);
    if (distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

export function formatStrikeLabel(strike: number): string {
  // 15 significant digits keep every listed decimal but drop binary noise from
  // computed strikes such as spot * 0.9.
  return Number.isFinite(strike)
    ? strike.toLocaleString("en-US", { maximumSignificantDigits: 15 }) : "—";
}

export function formatIv(value: number | undefined): string {
  // Providers send 0 for contracts with no implied volatility; "0.0%" would read
  // as a real quote of zero vol.
  if (value == null || !Number.isFinite(value) || value <= 0) return "\u2014";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * The width between the two quotes, as a share of their midpoint: the absolute
 * spread is a subtraction away from the neighbouring columns, while the share
 * is what makes one strike comparable to another. Bounded above by 200%, since
 * a zero bid leaves no midpoint at all. Why a quote has none is the status
 * bar's to say; the column has room only for the number.
 */
function formatSpreadPercent(contract: OptionContract): string {
  const spread = optionSpread(contract);
  return spread.kind === "two-sided" ? `${spread.percentOfMid.toFixed(1)}%` : "—";
}

function formatGreek(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "\u2014";
  return value.toFixed(3).replace(/^(-?)0\./, "$1.");
}

export function optionColumnColor(
  column: Pick<OptionColumn, "field" | "side">,
  surface = colors.bg,
): string {
  return optionRoleColor(optionColumnRole(column), surface);
}

function optionContractForColumn(row: OptionTableRow, column: OptionColumn): OptionContract | undefined {
  return column.side === "call" ? row.call : row.put;
}

function optionGreeksForColumn(row: OptionTableRow, column: OptionColumn): OptionValuation | undefined {
  return column.side === "call" ? row.callGreeks : row.putGreeks;
}

function optionColumnRole(column: Pick<OptionColumn, "field" | "side">): OptionColorRole {
  if (column.field === "strike") return "strike";
  if (column.field === "iv") return "iv";
  if (column.field === "volume" || column.field === "openInterest") return "activity";
  if (column.field === "bid" || column.field === "ask" || column.field === "spread" || column.field === "extrinsicPerYear") return "price";
  return column.side ?? "strike";
}

function optionRoleThemeColor(role: OptionColorRole): string {
  switch (role) {
    case "call":
    case "iv":
      return colors.positive;
    case "put":
      return colors.negative;
    case "price":
      return colors.warning;
    case "activity":
    case "strike":
      return colors.borderFocused;
  }
}

function mostReadableColor(surface: string, candidates: readonly string[]): string {
  return candidates.reduce((best, candidate) =>
    contrastRatio(candidate, surface) > contrastRatio(best, surface) ? candidate : best,
  );
}

function optionRoleColor(role: OptionColorRole, surface: string): string {
  const preferred = optionRoleThemeColor(role);
  const fallback = mostReadableColor(surface, [
    preferred,
    colors.text,
    colors.textBright,
    colors.selectedText,
    colors.neutral,
  ]);
  return blendForContrast(preferred, surface, fallback, OPTION_TEXT_MIN_CONTRAST);
}

function optionMutedColor(surface: string): string {
  const fallback = mostReadableColor(surface, [
    colors.textDim,
    colors.text,
    colors.textBright,
    colors.selectedText,
    colors.neutral,
  ]);
  return blendForContrast(colors.textDim, surface, fallback, OPTION_TEXT_MIN_CONTRAST);
}

function optionMoneynessBackground(
  row: OptionTableRow,
  contract: OptionContract | undefined,
  column: OptionColumn,
  rowState: { selected: boolean },
): string | undefined {
  if (rowState.selected || !column.side) return undefined;
  const outOfTheMoney = blendHex(colors.bg, colors.neutral, 0.055);
  if (!inferColumnMoneyness(row, contract, column.side)) return outOfTheMoney;
  return blendForSeparation(
    colors.bg,
    colors.neutral,
    outOfTheMoney,
    MONEYNESS_MIN_SEPARATION,
    MONEYNESS_MAX_TINT,
  );
}

function inferColumnMoneyness(
  row: OptionTableRow,
  contract: OptionContract | undefined,
  side: OptionSide,
): boolean {
  if (contract) return contract.inTheMoney;
  const oppositeContract = side === "call" ? row.put : row.call;
  return oppositeContract ? !oppositeContract.inTheMoney : false;
}

function formatOptionContractCell(
  row: OptionTableRow,
  contract: OptionContract | undefined,
  column: OptionColumn,
): string {
  if (!contract) return "—";
  const greeks = optionGreeksForColumn(row, column);
  switch (column.field) {
    case "last":
      return contract.lastPrice > 0 ? formatOptionPrice(contract.lastPrice, column.width) : "—";
    case "bid":
    case "ask": {
      const quote = optionQuoteSide(contract, column.field);
      return quote == null ? "—" : formatOptionPrice(quote, column.width);
    }
    case "spread":
      return formatSpreadPercent(contract);
    case "volume":
      return formatCompact(contract.volume, { fixedDecimals: true });
    case "openInterest":
      return formatCompact(contract.openInterest, { fixedDecimals: true });
    case "iv":
      return formatIv(row.impliedVolatility);
    case "delta":
      return formatGreek(greeks?.delta);
    case "gamma":
      return formatGreek(greeks?.gamma);
    case "theta":
      return formatGreek(greeks?.thetaPerDay);
    case "vega":
      return formatGreek(greeks?.vegaPerPoint);
    case "rho":
      return formatGreek(greeks?.rhoPerPoint);
    case "extrinsicPerYear":
      return formatCarryPercent(column.side === "call" ? row.callExtrinsicPerYear : row.putExtrinsicPerYear);
    case "strike":
      return formatStrikeLabel(contract.strike);
  }
}

export function renderOptionCell(
  row: OptionTableRow,
  column: OptionColumn,
  _index: number,
  cursorState: { selected: boolean },
  /** The contract the cursor row has picked: only its half and the strike take the highlight. */
  activeSide?: OptionSide | null,
): DataTableCell {
  const otherHalf = cursorState.selected && !!column.side && !!activeSide && column.side !== activeSide;
  const rowState = otherHalf ? { selected: false } : cursorState;
  const rowSurface = rowState.selected ? colors.selected : colors.bg;

  if (column.field === "strike") {
    const backgroundColor = rowState.selected
      ? undefined
      : blendHex(colors.bg, row.isPositionStrike ? colors.borderFocused : colors.header, row.isPositionStrike ? 0.18 : 0.1);
    const surface = backgroundColor ?? rowSurface;
    return {
      text: formatStrikeLabel(row.strike),
      color: optionRoleColor("strike", surface),
      backgroundColor,
      attributes: rowState.selected || row.isPositionStrike ? TextAttributes.BOLD : TextAttributes.NONE,
    };
  }

  const contract = optionContractForColumn(row, column);
  const backgroundColor = optionMoneynessBackground(row, contract, column, rowState);
  const surface = backgroundColor ?? rowSurface;
  return {
    text: formatOptionContractCell(row, contract, column),
    color: contract ? optionRoleColor(optionColumnRole(column), surface) : optionMutedColor(surface),
    keepColorWhenSelected: otherHalf,
    backgroundColor,
  };
}
