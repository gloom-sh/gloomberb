import { es } from "./es";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhCN } from "./zh-cn";
import { zhTW } from "./zh-tw";
import type { AppLanguage, LanguagePreference } from "./languages";

export type { AppLanguage, LanguagePreference } from "./languages";
export {
  LANGUAGE_DISPLAY_NAMES,
  LANGUAGE_PREFERENCES,
  parseLanguagePreference,
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
  } catch {
    return null;
  }
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
  } catch {
    // ignore and fall through
  }
  try {
    if (typeof navigator !== "undefined" && navigator.language) {
      const fromNavigator = normalizeLanguageTag(navigator.language);
      if (fromNavigator) return fromNavigator;
    }
  } catch {
    // ignore and fall through
  }
  return "en";
}

let currentLanguage: AppLanguage = detectLanguage();
const languageListeners = new Set<() => void>();

function updateLanguage(language: AppLanguage): void {
  if (currentLanguage === language) return;
  currentLanguage = language;
  for (const listener of languageListeners) listener();
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

/**
 * Translates a user-visible string. Keys are the original English text;
 * anything missing from the active dictionary falls back to English, so
 * untranslated or dynamic strings render unchanged.
 */
export function t(text: string): string {
  if (currentLanguage === "en") return text;
  return DICTIONARIES[currentLanguage][text] ?? text;
}

/**
 * Context-scoped translation for English homonyms (gettext msgctxt style).
 * Dictionary entries use the concatenated key of context and text; falls back to the
 * plain entry, then to the English text. Example: "Options" as a picker
 * heading (选项) vs. the Options plugin (期权).
 */
export function tc(context: string, text: string): string {
  if (currentLanguage === "en") return text;
  const dictionary = DICTIONARIES[currentLanguage];
  return dictionary[`${context}${text}`] ?? dictionary[text] ?? text;
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
