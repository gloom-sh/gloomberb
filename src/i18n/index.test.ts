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

  test("layers over the built-in table, latest wins, and its disposer restores the table", () => {
    setLanguage("zh-CN");
    const builtIn = t("Save");
    const removeFirst = registerTranslations("zh-CN", { "Plugin only label": "插件标签", Save: "存" });
    const removeSecond = registerTranslations("zh-CN", { Save: "存盘" });
    expect(t("Plugin only label")).toBe("插件标签");
    expect(t("Save")).toBe("存盘");
    expect(tc("no-such-context", "Save")).toBe("存盘");
    removeSecond();
    expect(t("Save")).toBe("存");
    removeFirst();
    expect(t("Save")).toBe(builtIn);
    expect(t("Plugin only label")).toBe("Plugin only label");
  });

  test("notifies subscribers only for the active language", () => {
    setLanguage("zh-CN");
    let notifications = 0;
    const unsubscribe = subscribeLanguage(() => { notifications += 1; });
    const removeJa = registerTranslations("ja", { "Only Japanese": "日本語のみ" });
    expect(notifications).toBe(0);
    expect(t("Only Japanese")).toBe("Only Japanese");
    const removeZh = registerTranslations("zh-CN", { "Only Chinese": "仅中文" });
    expect(notifications).toBe(1);
    removeZh();
    expect(notifications).toBe(2);
    removeJa();
    unsubscribe();
  });
});
