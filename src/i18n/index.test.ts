import { describe, expect, test } from "bun:test";
import {
  applyLanguageFromConfig,
  applyLanguagePreference,
  getLanguage,
  setLanguage,
  subscribeLanguage,
} from ".";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhCN } from "./zh-cn";
import { zhTW } from "./zh-tw";

function restoreEnvironmentLanguageOverride(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.GLOOMBERB_LANG;
  } else {
    process.env.GLOOMBERB_LANG = value;
  }
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
}

describe("language selection", () => {
  test("notifies subscribers only when the resolved language changes", () => {
    const previousLanguage = getLanguage();
    let notifications = 0;
    const unsubscribe = subscribeLanguage(() => {
      notifications += 1;
    });
    try {
      setLanguage(previousLanguage === "ja" ? "ko" : "ja");
      setLanguage(getLanguage());
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
      setLanguage(previousLanguage);
    }
  });

  test("keeps a valid environment override ahead of runtime preferences", () => {
    const previousOverride = process.env.GLOOMBERB_LANG;
    const previousLanguage = getLanguage();
    try {
      process.env.GLOOMBERB_LANG = "ko";
      setLanguage("en");

      applyLanguagePreference("ja");

      expect(getLanguage()).toBe("ko");
    } finally {
      restoreEnvironmentLanguageOverride(previousOverride);
      setLanguage(previousLanguage);
    }
  });

  test("ignores an unsupported override instead of blocking saved config", () => {
    const previousOverride = process.env.GLOOMBERB_LANG;
    const previousLanguage = getLanguage();
    try {
      process.env.GLOOMBERB_LANG = "fr-FR";
      setLanguage("en");

      applyLanguageFromConfig({ language: "zh-CN" });

      expect(getLanguage()).toBe("zh-CN");
    } finally {
      restoreEnvironmentLanguageOverride(previousOverride);
      setLanguage(previousLanguage);
    }
  });

  test("applies every persisted localized language", () => {
    const previousOverride = process.env.GLOOMBERB_LANG;
    const previousLanguage = getLanguage();
    try {
      delete process.env.GLOOMBERB_LANG;
      for (const language of ["zh-CN", "zh-TW", "ja", "ko"] as const) {
        setLanguage("en");
        applyLanguageFromConfig({ language });
        expect(getLanguage()).toBe(language);
      }
    } finally {
      restoreEnvironmentLanguageOverride(previousOverride);
      setLanguage(previousLanguage);
    }
  });

  test("auto-selects every supported locale family", () => {
    const previousOverride = process.env.GLOOMBERB_LANG;
    const previousLanguage = getLanguage();
    try {
      const cases = [
        ["zh", "zh-CN"],
        ["zh-SG", "zh-CN"],
        ["zh-Hans-CN", "zh-CN"],
        ["zh_CN.UTF-8", "zh-CN"],
        ["zh-TW", "zh-TW"],
        ["zh-HK", "zh-TW"],
        ["zh-Hant", "zh-TW"],
        ["ja-JP", "ja"],
        ["ja_JP.UTF-8", "ja"],
        ["ko-KR", "ko"],
      ] as const;
      for (const [locale, expected] of cases) {
        process.env.GLOOMBERB_LANG = locale;
        applyLanguagePreference("auto");
        expect(getLanguage()).toBe(expected);
      }

      process.env.GLOOMBERB_LANG = "zh-US";
      applyLanguagePreference("auto");
      expect(getLanguage()).toBe("en");
    } finally {
      restoreEnvironmentLanguageOverride(previousOverride);
      setLanguage(previousLanguage);
    }
  });

  test("keeps every locale dictionary aligned to the canonical key set", () => {
    const canonicalKeys = Object.keys(zhCN).sort();
    for (const dictionary of [zhTW, ja, ko]) {
      expect(Object.keys(dictionary).sort()).toEqual(canonicalKeys);
      expect(canonicalKeys.filter((key) => (
        JSON.stringify(placeholders(dictionary[key] ?? "")) !== JSON.stringify(placeholders(key))
      ))).toEqual([]);
    }
  });
});
