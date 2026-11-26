import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  applyLanguageFromConfig,
  applyLanguagePreference,
  getLanguage,
  registerTranslations,
  setLanguage,
  subscribeLanguage,
  t,
  tc,
  tPlugin,
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

describe("registerTranslations", () => {
  let previousLanguage: ReturnType<typeof getLanguage>;
  beforeEach(() => {
    previousLanguage = getLanguage();
  });
  afterEach(() => {
    setLanguage(previousLanguage);
  });

  test("looks up only own keys within a plugin and disposes each registration once", () => {
    setLanguage("zh-CN");
    const builtIn = t("Save");
    const entries = Object.assign(Object.create({ inherited: "not a translation" }), { Save: "存" });
    const removeFirst = registerTranslations("first", "zh-CN", entries);
    const removeLatest = registerTranslations("first", "zh-CN", { Save: "存盘" });
    const removeOther = registerTranslations("other", "zh-CN", { Save: "保存文件" });
    try {
      expect(tPlugin("first", "Save", "Fallback")).toBe("存盘");
      expect(tPlugin("other", "Save", "Fallback")).toBe("保存文件");
      expect(tPlugin("first", "inherited", "Fallback")).toBe("Fallback");
      expect(tPlugin("first", "constructor", "Fallback")).toBe("Fallback");
      expect(tPlugin("missing", "Save", "Fallback")).toBe("Fallback");
      expect(t("Save")).toBe(builtIn);
      expect(tc("no-such-context", "Save")).toBe(builtIn);
      expect(t("constructor")).toBe("constructor");
      expect(tc("to", "String")).toBe("String");
      removeLatest();
      removeLatest();
      expect(tPlugin("first", "Save", "Fallback")).toBe("存");
      removeFirst();
      expect(tPlugin("first", "Save", "Fallback")).toBe("Fallback");
    } finally {
      removeLatest();
      removeFirst();
      removeOther();
    }
  });

  test("notifies subscribers only for the active language", () => {
    setLanguage("zh-CN");
    let notifications = 0;
    const unsubscribe = subscribeLanguage(() => { notifications += 1; });
    const removeJa = registerTranslations("first", "ja", { label: "日本語のみ" });
    try {
      expect(notifications).toBe(0);
      expect(tPlugin("first", "label", "Only Japanese")).toBe("Only Japanese");
      removeJa();
      expect(notifications).toBe(0);
    } finally {
      removeJa();
      unsubscribe();
    }
  });
});
