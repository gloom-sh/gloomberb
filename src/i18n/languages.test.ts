import { describe, expect, test } from "bun:test";
import {
  isLanguagePreference,
  LANGUAGE_PREFERENCES,
  parseLanguagePreference,
  resolveLanguageCommandPreference,
} from "./languages";

describe("language preferences", () => {
  test("recognizes every persisted preference", () => {
    for (const preference of LANGUAGE_PREFERENCES) {
      expect(isLanguagePreference(preference)).toBe(true);
    }
    expect(isLanguagePreference("fr")).toBe(false);
  });

  test("parses locale names and native language aliases", () => {
    expect(parseLanguagePreference("Spanish")).toBe("es");
    expect(parseLanguagePreference("español")).toBe("es");
    expect(parseLanguagePreference("es-AR")).toBe("es");
    expect(parseLanguagePreference("traditional chinese")).toBe("zh-TW");
    expect(parseLanguagePreference("繁體中文")).toBe("zh-TW");
    expect(parseLanguagePreference("日本語")).toBe("ja");
    expect(parseLanguagePreference("Korean")).toBe("ko");
    expect(parseLanguagePreference("unknown")).toBeNull();
  });

  test("cycles only for a bare language command", () => {
    expect(resolveLanguageCommandPreference("auto", "")).toBe("en");
    expect(resolveLanguageCommandPreference("en", "   ")).toBe("es");
    expect(resolveLanguageCommandPreference("en", "ja")).toBe("ja");
    expect(resolveLanguageCommandPreference("en", "fr")).toBeNull();
  });
});
