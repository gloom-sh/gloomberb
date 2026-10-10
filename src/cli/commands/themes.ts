import { DEFAULT_THEME, listThemes, resolveThemeId, themes, type ThemeSummary } from "../../theme/themes";
import { fail } from "../errors";

const THEME_TRAIT_NOTES = { "high-contrast": "high contrast", "colorblind-safe": "color-blind safe" } as const;

/** `white (White Phosphor)`, or what the app shows instead of an id it does not know. */
export function describeThemeId(id: string): string {
  const theme = themes[id];
  if (theme) return `${id} (${theme.name})`;
  return `${id}, not a theme: the app shows ${describeThemeId(DEFAULT_THEME)}`;
}

/** Every id with its name, from the registry, for an error that has to say what would have worked. */
export function themeChoicesText(): string {
  const choices = listThemes().map(({ id, name }) => `${id} (${name})`).join(", ");
  return `Themes: ${choices}. gloomberb config themes lists them with notes.`;
}

/**
 * The id `input` names, by id or display name in any case. Anything else
 * fails with the closest id when there is one, and every id with its name.
 */
export function requireThemeId(input: string): string {
  const lookup = resolveThemeId(input);
  if (lookup.ok) return lookup.id;
  const hint = lookup.suggestion ? ` Did you mean ${describeThemeId(lookup.suggestion)}?` : "";
  return fail(`Unknown theme "${input.trim()}".${hint}`, themeChoicesText());
}

export interface ThemeListRow extends Record<string, unknown> {
  id: string;
  name: string;
  appearance: ThemeSummary["appearance"];
  colorblindSafe: boolean;
  highContrast: boolean;
  default: boolean;
  current: boolean;
}

export function themeListRows(currentThemeId: string | null): ThemeListRow[] {
  return listThemes().map((theme) => ({
    id: theme.id,
    name: theme.name,
    appearance: theme.appearance,
    colorblindSafe: theme.traits.includes("colorblind-safe"),
    highContrast: theme.traits.includes("high-contrast"),
    default: theme.id === DEFAULT_THEME,
    current: theme.id === currentThemeId,
  }));
}

export function themeListNote(row: ThemeListRow): string {
  const notes: string[] = [];
  if (row.highContrast) notes.push(THEME_TRAIT_NOTES["high-contrast"]);
  if (row.colorblindSafe) notes.push(THEME_TRAIT_NOTES["colorblind-safe"]);
  if (row.default) notes.push("default");
  if (row.current) notes.push("current");
  return notes.join(", ");
}

/** The name of a theme id the registry knows, null for one it does not. */
export function themeName(id: string): string | null {
  return themes[id]?.name ?? null;
}
