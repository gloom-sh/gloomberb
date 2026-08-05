export const APP_LANGUAGES = ["en", "es", "zh-CN", "zh-TW", "ja", "ko"] as const;

export type AppLanguage = typeof APP_LANGUAGES[number];

export const LANGUAGE_PREFERENCES = ["auto", ...APP_LANGUAGES] as const;

export type LanguagePreference = typeof LANGUAGE_PREFERENCES[number];

export const LANGUAGE_DISPLAY_NAMES: Record<LanguagePreference, string> = {
  auto: "Auto",
  en: "English",
  es: "Español",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  ko: "한국어",
};

const LANGUAGE_ALIASES: Record<string, LanguagePreference> = {
  auto: "auto",
  system: "auto",
  en: "en",
  english: "en",
  es: "es",
  "es-es": "es",
  "es-419": "es",
  "es-ar": "es",
  "es-mx": "es",
  "es-cl": "es",
  "es-co": "es",
  spanish: "es",
  "español": "es",
  "espanol": "es",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-my": "zh-CN",
  "zh-hans": "zh-CN",
  "zh-hans-cn": "zh-CN",
  simplified: "zh-CN",
  "simplified chinese": "zh-CN",
  中文: "zh-CN",
  简体: "zh-CN",
  简体中文: "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "zh-mo": "zh-TW",
  "zh-hant": "zh-TW",
  "zh-hant-tw": "zh-TW",
  traditional: "zh-TW",
  "traditional chinese": "zh-TW",
  繁体: "zh-TW",
  繁體: "zh-TW",
  繁体中文: "zh-TW",
  繁體中文: "zh-TW",
  ja: "ja",
  "ja-jp": "ja",
  jp: "ja",
  japanese: "ja",
  日本語: "ja",
  ko: "ko",
  "ko-kr": "ko",
  kr: "ko",
  korean: "ko",
  한국어: "ko",
};

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === "string" && (LANGUAGE_PREFERENCES as readonly string[]).includes(value);
}

export function parseLanguagePreference(value: string): LanguagePreference | null {
  return LANGUAGE_ALIASES[value.trim().toLowerCase().replaceAll("_", "-")] ?? null;
}

export function resolveLanguageCommandPreference(
  current: LanguagePreference,
  input: string,
): LanguagePreference | null {
  if (input.trim()) return parseLanguagePreference(input);
  const currentIndex = LANGUAGE_PREFERENCES.indexOf(current);
  return LANGUAGE_PREFERENCES[(currentIndex + 1) % LANGUAGE_PREFERENCES.length] ?? "auto";
}
