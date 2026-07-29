import { afterEach, describe, expect, test } from "bun:test";
import {
  applyTheme,
  clearTransientThemePreview,
  getCurrentThemeId,
  getThemeColors,
  previewTheme,
  syncTheme,
} from "./colors";
import { DEFAULT_THEME, getTheme } from "./themes";

const originalDocument = (globalThis as Record<string, unknown>).document;

function setDocument(value: unknown): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value,
  });
}

function installDocumentStyleMock() {
  const values = new Map<string, string>();
  setDocument({
    documentElement: {
      style: {
        setProperty(name: string, value: string) {
          values.set(name, value);
        },
      },
    },
  });
  return values;
}

afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    setDocument(originalDocument);
  }
  clearTransientThemePreview();
  syncTheme(DEFAULT_THEME);
});

describe("theme colors", () => {
  test("provides immutable palette snapshots while the compatibility facade follows the active theme", () => {
    const amber = getThemeColors(DEFAULT_THEME);
    const midnight = getThemeColors("midnight");

    expect(Object.isFrozen(amber)).toBe(true);
    expect(Object.isFrozen(midnight)).toBe(true);
    expect(amber).not.toBe(midnight);
  });

  test("syncs CSS variables when a theme is applied", () => {
    const values = installDocumentStyleMock();
    const theme = getTheme("midnight");

    applyTheme("midnight");

    expect(values.get("--gloom-bg")).toBe(theme.bg);
    expect(values.get("--gloom-panel")).toBe(theme.panel);
    expect(values.get("--gloom-text-dim")).toBe(theme.textDim);
    expect(values.get("--gloom-selected")).toBe(theme.selected);
    expect(values.get("--gloom-hover-bg")).toBeString();
  });

  test("does not let provider sync clobber a pending preview", () => {
    const values = installDocumentStyleMock();
    const preview = getTheme("midnight");

    previewTheme("midnight");
    syncTheme(DEFAULT_THEME);

    expect(getCurrentThemeId()).toBe("midnight");
    expect(values.get("--gloom-bg")).toBe(preview.bg);

    clearTransientThemePreview();
    syncTheme(DEFAULT_THEME);

    expect(getCurrentThemeId()).toBe(DEFAULT_THEME);
    expect(values.get("--gloom-bg")).toBe(getTheme(DEFAULT_THEME).bg);
  });
});
