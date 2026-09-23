import type { PaneSettingField } from "../../types/plugin";
import { t } from "../../i18n";

export function isSpaceKey(event: { name?: string; sequence?: string }): boolean {
  return event.name === "space" || event.name === " " || event.sequence === " ";
}

/** An action row that cannot run now: the mouse ignores it and the cursor steps over it. */
export function isPaneSettingDisabled(field: PaneSettingField): boolean {
  return field.type === "action" && field.disabled === true;
}

export function summarizePaneSettingValue(field: PaneSettingField, value: unknown): string {
  switch (field.type) {
    case "action":
      return t(field.actionLabel ?? "Open");
    case "toggle":
      return value === true ? t("On") : t("Off");
    case "text":
      return typeof value === "string" && value.trim().length > 0 ? value : t("Unset");
    case "select": {
      const option = field.options.find((entry) => entry.value === value);
      return option?.label ? t(option.label) : t("Unset");
    }
    case "multi-select":
    case "ordered-multi-select": {
      const selectedValues = coerceSelectedPaneSettingValues(value);
      if (selectedValues.length === 0) return t("None");
      const labels = selectedValues
        .map((selectedValue) => { const label = field.options.find((entry) => entry.value === selectedValue)?.label; return label ? t(label) : selectedValue; })
        .slice(0, 3);
      const suffix = selectedValues.length > 3 ? ` +${selectedValues.length - 3}` : "";
      return `${labels.join(", ")}${suffix}`;
    }
    default:
      return "";
  }
}

export function coerceSelectedPaneSettingValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The option one step from the current value, wrapping at the ends. An unset
 * value steps onto the first or last option.
 */
export function stepPaneSettingSelect(
  field: Extract<PaneSettingField, { type: "select" }>,
  value: unknown,
  direction: -1 | 1,
): string | null {
  const options = field.options;
  if (options.length === 0) return null;
  const index = options.findIndex((option) => option.value === value);
  if (index < 0) return (direction > 0 ? options[0] : options[options.length - 1])!.value;
  const next = options[(index + direction + options.length) % options.length]!;
  return next.value === value ? null : next.value;
}
