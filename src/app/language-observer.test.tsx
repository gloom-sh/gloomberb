import { afterEach, describe, expect, test } from "bun:test";
import { act, type Dispatch } from "react";
import { getLanguage, setLanguage, t } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { testRender } from "../renderers/opentui/test-utils";
import {
  AppProvider,
  useAppDispatch,
  type AppAction,
} from "../state/app/context";
import { createDefaultConfig } from "../types/config";
import { AppLanguageConfigObserver } from "./language-observer";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let dispatch: Dispatch<AppAction> | null = null;

function DispatchCapture() {
  dispatch = useAppDispatch();
  return null;
}

function LanguageProbe() {
  useAppLanguage();
  return <text>{t("Done")}</text>;
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup?.renderer.destroy());
  }
  testSetup = undefined;
  dispatch = null;
  setLanguage("en");
});

async function renderSettled() {
  await act(async () => {
    await testSetup?.renderOnce();
    await testSetup?.renderOnce();
  });
}

describe("AppLanguageConfigObserver", () => {
  test("tracks language changes from config replacement and desktop hydration", async () => {
    const config = { ...createDefaultConfig("/tmp/gloomberb-language-observer"), language: "en" as const };
    testSetup = await testRender(
      <AppProvider config={config}>
        <AppLanguageConfigObserver />
        <DispatchCapture />
        <LanguageProbe />
      </AppProvider>,
      { width: 20, height: 2 },
    );

    await renderSettled();
    expect(getLanguage()).toBe("en");
    expect(testSetup.captureCharFrame()).toContain("Done");

    act(() => {
      dispatch?.({ type: "SET_CONFIG", config: { ...config, language: "zh-CN" } });
    });
    await renderSettled();
    expect(getLanguage()).toBe("zh-CN");
    expect(testSetup.captureCharFrame()).toContain("完成");

    act(() => {
      dispatch?.({
        type: "HYDRATE_DESKTOP_SNAPSHOT",
        snapshot: {
          config: { ...config, language: "ko" },
          paneState: {},
          focusedPaneId: null,
          activePanel: "left",
          statusBarVisible: true,
        },
      });
    });
    await renderSettled();
    expect(getLanguage()).toBe("ko");
    expect(testSetup.captureCharFrame()).toContain("완료");
  });
});
