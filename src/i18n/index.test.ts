import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyLanguageFromConfig,
  applyLanguagePreference,
  getLanguage,
  setLanguage,
  subscribeLanguage,
} from ".";
import { es } from "./es";
import { ja } from "./ja";
import { ko } from "./ko";
import { zhCN } from "./zh-cn";
import { zhTW } from "./zh-tw";

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort();
}

describe("language selection", () => {
  let previousOverride: string | undefined;
  let previousLanguage: ReturnType<typeof getLanguage>;

  beforeEach(() => {
    previousOverride = process.env.GLOOMBERB_LANG;
    previousLanguage = getLanguage();
  });

  afterEach(() => {
    if (previousOverride === undefined) {
      delete process.env.GLOOMBERB_LANG;
    } else {
      process.env.GLOOMBERB_LANG = previousOverride;
    }
    setLanguage(previousLanguage);
  });

  test("notifies subscribers only when the resolved language changes", () => {
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
    }
  });

  test("keeps a valid environment override ahead of runtime preferences", () => {
    process.env.GLOOMBERB_LANG = "ko";
    setLanguage("en");

    applyLanguagePreference("ja");

    expect(getLanguage()).toBe("ko");
  });

  test("ignores an unsupported override instead of blocking saved config", () => {
    process.env.GLOOMBERB_LANG = "fr-FR";
    setLanguage("en");

    applyLanguageFromConfig({ language: "zh-CN" });

    expect(getLanguage()).toBe("zh-CN");
  });

  test("auto-selects every supported locale family", () => {
    const cases = [
      ["zh", "zh-CN"],
      ["zh-SG", "zh-CN"],
      ["zh-Hans-CN", "zh-CN"],
      ["zh_CN.UTF-8", "zh-CN"],
      ["zh-TW", "zh-TW"],
      ["zh-HK", "zh-TW"],
      ["zh-Hant", "zh-TW"],
      ["es-AR", "es"],
      ["es_ES.UTF-8", "es"],
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
  });

  test("keeps every locale dictionary aligned to the canonical key set", () => {
    const canonicalKeys = Object.keys(zhCN).sort();
    for (const dictionary of [es, zhTW, ja, ko]) {
      expect(Object.keys(dictionary).sort()).toEqual(canonicalKeys);
      expect(canonicalKeys.filter((key) => (
        JSON.stringify(placeholders(dictionary[key] ?? "")) !== JSON.stringify(placeholders(key))
      ))).toEqual([]);
    }
  });
});
