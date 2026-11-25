import { es } from "./es";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhCN } from "./zh-cn";
import { zhTW } from "./zh-tw";
import type { AppLanguage, LanguagePreference } from "./languages";

export type { AppLanguage, LanguagePreference } from "./languages";
export {
  LANGUAGE_DISPLAY_NAMES,
  resolveLanguageCommandPreference,
} from "./languages";

const DICTIONARIES: Record<Exclude<AppLanguage, "en">, Record<string, string>> = {
  es,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
};

function normalizeLanguageTag(tag: string): AppLanguage | null {
  const normalized = tag
    .trim()
    .toLowerCase()
    .split(/[.@]/, 1)[0]
    ?.replaceAll("_", "-");
  if (!normalized) return null;
  const [language, ...variants] = normalized.split("-");
  if (language === "en") return "en";
  if (language === "es") return "es";
  if (language === "ja") return "ja";
  if (language === "ko") return "ko";
  if (language === "zh") {
    if (variants.length === 0) return "zh-CN";
    if (variants.includes("hant") || variants.includes("cht")) return "zh-TW";
    if (variants.includes("hans") || variants.includes("chs")) return "zh-CN";
    if (variants.some((variant) => variant === "tw" || variant === "hk" || variant === "mo")) return "zh-TW";
    if (variants.some((variant) => variant === "cn" || variant === "sg" || variant === "my")) return "zh-CN";
  }
  return null;
}

function getEnvironmentLanguageOverride(): AppLanguage | null {
  try {
    return typeof process !== "undefined" && process.env?.GLOOMBERB_LANG
      ? normalizeLanguageTag(process.env.GLOOMBERB_LANG)
      : null;
  } catch { /* Intentional ignore: Environment locale access is optional; language detection falls back to the browser or English. */ return null; }
}

function detectLanguage(): AppLanguage {
  try {
    if (typeof process !== "undefined" && process.env) {
      const env = process.env;
      const override = getEnvironmentLanguageOverride();
      if (override) return override;
      // Keep the test suite deterministic regardless of the host locale.
      if (env.NODE_ENV === "test") return "en";
      const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
      const fromLocale = normalizeLanguageTag(locale);
      if (fromLocale) return fromLocale;
    }
  } catch { /* Intentional ignore: Environment locale access is optional; language detection falls back to the browser or English. */ }
  try {
    if (typeof navigator !== "undefined" && navigator.language) {
      const fromNavigator = normalizeLanguageTag(navigator.language);
      if (fromNavigator) return fromNavigator;
    }
  } catch { /* Intentional ignore: Browser locale access is optional; language detection falls back to English. */ }
  return "en";
}

let currentLanguage: AppLanguage = detectLanguage();
const languageListeners = new Set<() => void>();

let translationRevision = 0;

function notifyLanguageListeners(): void {
  translationRevision += 1;
  for (const listener of languageListeners) listener();
}

export function getTranslationRevision(): number {
  return translationRevision;
}

function updateLanguage(language: AppLanguage): void {
  if (currentLanguage === language) return;
  currentLanguage = language;
  notifyLanguageListeners();
}

export function getLanguage(): AppLanguage {
  return currentLanguage;
}

export function setLanguage(language: AppLanguage): void {
  updateLanguage(language);
}

export function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

/**
 * Applies the persisted `language` config field once the app config is
 * available. An explicit GLOOMBERB_LANG env var still wins so a single run
 * can be forced into another language without touching the config.
 */
export function applyLanguageFromConfig(config: { language?: string } | null | undefined): void {
  const override = getEnvironmentLanguageOverride();
  if (override) {
    updateLanguage(override);
    return;
  }
  const configured = config?.language;
  if (!configured || configured === "auto") {
    updateLanguage(detectLanguage());
    return;
  }
  const normalized = normalizeLanguageTag(configured);
  if (normalized) updateLanguage(normalized);
}

/**
 * Applies an explicit user language choice at runtime (from the LANG
 * command). "auto" re-runs environment detection.
 */
export function applyLanguagePreference(preference: LanguagePreference): void {
  updateLanguage(
    getEnvironmentLanguageOverride()
      ?? (preference === "auto" ? detectLanguage() : preference),
  );
}

type TranslatedLanguage = keyof typeof DICTIONARIES;
const pluginTranslations = new Map<string, Map<TranslatedLanguage, Map<string, string>[]>>();
let disabledTranslationPlugins = new Set<string>();

export function setDisabledTranslationPlugins(pluginIds: readonly string[]): void {
  const next = new Set(pluginIds);
  const language = currentLanguage;
  const changed = language !== "en" && [...pluginTranslations].some(([pluginId, languages]) =>
    languages.has(language) && next.has(pluginId) !== disabledTranslationPlugins.has(pluginId));
  disabledTranslationPlugins = next;
  if (changed) notifyLanguageListeners();
}

/**
 * Registers a plugin's own keys for one language. The latest entry for a key
 * in this plugin and language wins until its disposer is called.
 */
export function registerTranslations(
  pluginId: string,
  language: TranslatedLanguage,
  entries: Readonly<Record<string, string>>,
): () => void {
  if (!Object.hasOwn(DICTIONARIES, language)) {
    throw new Error(`Cannot register translations for unsupported language "${language}".`);
  }
  const table = new Map(Object.entries(entries));
  const languages = pluginTranslations.get(pluginId) ?? new Map<TranslatedLanguage, Map<string, string>[]>();
  const tables = languages.get(language) ?? [];
  tables.push(table);
  languages.set(language, tables);
  pluginTranslations.set(pluginId, languages);
  if (currentLanguage === language && !disabledTranslationPlugins.has(pluginId)) notifyLanguageListeners();
  return () => {
    const index = tables.indexOf(table);
    if (index < 0) return;
    tables.splice(index, 1);
    if (!tables.length) languages.delete(language);
    if (!languages.size) pluginTranslations.delete(pluginId);
    if (currentLanguage === language && !disabledTranslationPlugins.has(pluginId)) notifyLanguageListeners();
  };
}

/** Looks up only the specified plugin's key, falling back to the supplied text. */
export function tPlugin(pluginId: string, key: string, fallback: string): string {
  if (currentLanguage === "en" || disabledTranslationPlugins.has(pluginId)) return fallback;
  const tables = pluginTranslations.get(pluginId)?.get(currentLanguage);
  if (tables) {
    for (let index = tables.length - 1; index >= 0; index -= 1) {
      const value = tables[index]!.get(key);
      if (value !== undefined) return value;
    }
  }
  return fallback;
}

function lookup(language: TranslatedLanguage, key: string): string | undefined {
  const dictionary = DICTIONARIES[language];
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

/**
 * Translates a user-visible string. Keys are the original English text;
 * anything missing from the active dictionary falls back to English, so
 * untranslated or dynamic strings render unchanged.
 */
export function t(text: string): string {
  if (currentLanguage === "en") return text;
  return lookup(currentLanguage, text) ?? text;
}

/**
 * Context-scoped translation for English homonyms (gettext msgctxt style).
 * Dictionary entries use the concatenated key of context and text; falls back to the
 * plain entry, then to the English text. Example: "Options" as a picker
 * heading (选项) vs. the Options plugin (期权).
 */
export function tc(context: string, text: string): string {
  if (currentLanguage === "en") return text;
  return lookup(currentLanguage, `${context}${text}`) ?? lookup(currentLanguage, text) ?? text;
}

/**
 * Translates a template with `{placeholder}` params, e.g.
 * `tf("Published {date}", { date })`. The template (with placeholders intact)
 * is the dictionary key; params are substituted after lookup.
 */
export function tf(template: string, params: Record<string, string | number>): string {
  const translated = t(template);
  return translated.replace(/\{(\w+)\}/g, (match, key: string) => (
    key in params ? String(params[key]) : match
  ));
}
