import { afterEach, beforeEach, expect, test } from "bun:test";
import { getLanguage, registerTranslations, setLanguage } from "../../i18n";
import { translateHeaderLabel } from "./header-case";

let previousLanguage: ReturnType<typeof getLanguage>;
beforeEach(() => {
  previousLanguage = getLanguage();
});
afterEach(() => {
  setLanguage(previousLanguage);
});

test("headers stay in English unless a plugin registers a header entry", () => {
  setLanguage("zh-CN");
  // Plain UI entries exist for these words (Open is the verb 打开), but a
  // header only takes an explicit table-header entry.
  expect(translateHeaderLabel("Open")).toBe("Open");
  expect(translateHeaderLabel("Volume")).toBe("Volume");
  const remove = registerTranslations("zh-CN", { "table-headerOPEN": "开盘" });
  expect(translateHeaderLabel("Open")).toBe("开盘");
  expect(translateHeaderLabel("OPEN")).toBe("开盘");
  setLanguage("en");
  expect(translateHeaderLabel("Open")).toBe("Open");
  setLanguage("zh-CN");
  remove();
  expect(translateHeaderLabel("Open")).toBe("Open");
});
