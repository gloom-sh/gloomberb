import type { PaneReportOptionDef, PaneSettingsContext, PaneSettingsDef } from "../../../types/plugin";
import { CURRENCY_SETS, FX_CURRENCIES, MAJOR_CURRENCIES, isFxCurrency, resolveCurrencies } from "./pairs";

const CUSTOM_SET = "custom";

let currencyNames: Intl.DisplayNames | null | undefined;

/** ISO has no code for the offshore yuan, so the runtime has no name for it. */
const CURRENCY_NAMES: Partial<Record<string, string>> = { CNH: "Chinese Yuan (Offshore)" };

/** A currency's English name for the picker, or null where the runtime has no names. */
function currencyName(code: string): string | null {
  if (CURRENCY_NAMES[code]) return CURRENCY_NAMES[code]!;
  try {
    currencyNames ??= new Intl.DisplayNames(["en"], { type: "currency" });
    const name = currencyNames.of(code);
    return name && name !== code ? name : null;
  } catch {
    currencyNames = null;
    return null;
  }
}

/**
 * Currencies are chosen as an ordered list. A set fills that list in one pick;
 * the list stays editable, and reads as Custom once it stops matching a set.
 */
export function fxMatrixSettings(context: PaneSettingsContext): PaneSettingsDef {
  const currencies = resolveCurrencies(context.settings.currencies);
  const matching = CURRENCY_SETS.find((set) => (
    set.currencies.length === currencies.length && set.currencies.every((code, index) => code === currencies[index])
  ));
  return {
    title: "FX Cross Rates Settings",
    values: { currencies, currencySet: matching?.id ?? CUSTOM_SET },
    fields: [
      {
        key: "currencySet",
        label: "Currency set",
        type: "select",
        options: [
          ...CURRENCY_SETS.map((set) => ({ value: set.id, label: set.label })),
          { value: CUSTOM_SET, label: "Custom" },
        ],
      },
      {
        key: "currencies",
        label: "Currencies",
        type: "ordered-multi-select",
        searchable: true,
        options: FX_CURRENCIES.map((code) => ({ value: code, label: code, description: currencyName(code) ?? undefined })),
      },
    ],
    applyValue: (settings, field, value) => {
      if (field.key !== "currencySet") return { ...settings, [field.key]: value };
      // The set is a way to fill the list, never a setting of its own.
      const { currencySet: _unused, ...rest } = settings;
      const set = CURRENCY_SETS.find((candidate) => candidate.id === value);
      return set ? { ...rest, currencies: [...set.currencies] } : rest;
    },
  };
}

const SET_NAMES = CURRENCY_SETS.map((set) => set.id).join(", ");

/**
 * `--currencies` as typed: codes and set names in any case, separated by
 * commas or spaces, returned as the codes in order without repeats. A token
 * that is neither fails, naming it and the codes the board carries, where the
 * pane setting would drop it and quietly show the majors.
 */
function parseCurrenciesOption(value: string): string {
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  const unknown = tokens.filter((token) => (
    !isFxCurrency(token.toUpperCase()) && !CURRENCY_SETS.some((set) => set.id === token.toLowerCase())
  ));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown ${unknown.length > 1 ? "currencies" : "currency"} ${unknown.join(", ")} for --currencies. `
      + `Use codes from ${FX_CURRENCIES.join(", ")}, or a set: ${SET_NAMES}.`,
    );
  }
  if (tokens.length === 0) throw new Error("--currencies needs at least one code, such as USD,ZAR,NGN.");
  return resolveCurrencies(value).join(",");
}

/** `fn FXC --currencies USD,ZAR,NGN`: the board's currency list, as its settings choose it. */
export const FX_MATRIX_REPORT_OPTIONS: readonly PaneReportOptionDef[] = [{
  key: "currencies",
  type: "string",
  placeholder: "codes",
  description: `The currencies to cross, in order: codes separated by commas, or a set (${SET_NAMES}). `
    + `Without it, the ${MAJOR_CURRENCIES.length} majors. Codes: ${FX_CURRENCIES.join(", ")}`,
  example: "--currencies USD,ZAR,NGN,SAR,ILS",
  normalize: parseCurrenciesOption,
}];

/** A report of the default board says it is only the majors, and how to choose others. */
export function fxMatrixReportNotices(settings: Readonly<Record<string, unknown>>): string[] {
  if (settings.currencies != null) return [];
  return [`Showing the ${MAJOR_CURRENCIES.length} majors. Choose others with --currencies USD,ZAR,NGN; gloomberb catalog FXC lists all ${FX_CURRENCIES.length}.`];
}
