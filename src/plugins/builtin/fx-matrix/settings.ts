import type { PaneSettingsContext, PaneSettingsDef } from "../../../types/plugin";
import { CURRENCY_SETS, FX_CURRENCIES, resolveCurrencies } from "./pairs";

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
