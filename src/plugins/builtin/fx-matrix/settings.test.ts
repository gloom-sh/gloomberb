import { expect, test } from "bun:test";
import type { PaneSettingField, PaneSettingsContext } from "../../../types/plugin";
import { CURRENCY_SETS, FX_CURRENCIES, MAJOR_CURRENCIES } from "./pairs";
import { fxMatrixSettings } from "./settings";

const context = (settings: Record<string, unknown>) => ({ settings }) as unknown as PaneSettingsContext;
const field = (def: ReturnType<typeof fxMatrixSettings>, key: string) => def.fields.find((entry) => entry.key === key) as PaneSettingField;

test("an untouched pane lists the majors, and the set picker reads Custom once the list is edited", () => {
  expect(fxMatrixSettings(context({})).values).toEqual({ currencies: [...MAJOR_CURRENCIES], currencySet: "majors" });
  expect(fxMatrixSettings(context({ currencies: ["KRW", "USD"] })).values).toEqual({ currencies: ["KRW", "USD"], currencySet: "custom" });
  // The order is part of a set: the same codes in another order are a custom list.
  expect(fxMatrixSettings(context({ currencies: [...MAJOR_CURRENCIES].reverse() })).values?.currencySet).toBe("custom");
});

test("a set fills the saved list without being saved itself, and Custom leaves the list alone", async () => {
  const def = fxMatrixSettings(context({}));
  const apply = def.applyValue!;
  const saved = { currencies: ["KRW"], currencySet: "asia", lockPane: true };
  const asia = await apply(saved, field(def, "currencySet"), "asia", context(saved));
  expect(asia.currencies).toEqual(CURRENCY_SETS.find((set) => set.id === "asia")!.currencies);
  expect(asia).not.toHaveProperty("currencySet");
  expect(asia.lockPane).toBe(true);
  expect(await apply(saved, field(def, "currencySet"), "custom", context(saved))).toEqual({ currencies: ["KRW"], lockPane: true });
  // Any user order is saved as given, and a list edit never touches the picker.
  const edited = await apply(saved, field(def, "currencies"), ["ZAR", "USD", "KRW"], context(saved));
  expect(edited.currencies).toEqual(["ZAR", "USD", "KRW"]);
  expect(CURRENCY_SETS.every((set) => set.currencies.every((code) => FX_CURRENCIES.includes(code)))).toBe(true);
});
