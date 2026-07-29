import { afterEach, describe, expect, test } from "bun:test";
import { act, type Dispatch } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { AppProvider, useAppDispatch, type AppAction } from "../../../state/app/context";
import { setLanguage, t } from "../../../i18n";
import { applyTheme, colors } from "../../../theme/colors";
import { getTheme } from "../../../theme/themes";
import { createDefaultConfig } from "../../../types/config";
import { PaneContent } from "./content";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let capturedDispatch: Dispatch<AppAction> | null = null;

function DispatchCapture() {
  capturedDispatch = useAppDispatch();
  return null;
}

function ThemeColorProbe() {
  return <text>{colors.textBright}</text>;
}

function LanguageProbe() {
  return <text>{t("Done")}</text>;
}

describe("PaneContent", () => {
  afterEach(async () => {
    if (testSetup) {
      await act(async () => testSetup?.renderer.destroy());
    }
    testSetup = undefined;
    capturedDispatch = null;
    applyTheme("amber");
    setLanguage("en");
  });

  test("rerenders legacy pane colors when the theme preview changes", async () => {
    const config = {
      ...createDefaultConfig("/tmp/gloomberb-test"),
      theme: "amber",
    };

    testSetup = await testRender(
      <AppProvider config={config}>
        <DispatchCapture />
        <PaneContent
          component={ThemeColorProbe}
          paneId="theme-preview:test"
          paneType="test"
          focused
          width={24}
          height={4}
        />
      </AppProvider>,
      { width: 32, height: 6 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain(getTheme("amber").textBright);

    await act(async () => {
      capturedDispatch?.({ type: "PREVIEW_THEME", theme: "green" });
      await testSetup!.renderOnce();
    });
    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain(getTheme("green").textBright);
    expect(frame).not.toContain(getTheme("amber").textBright);
  });

  test("rerenders pane bodies when the app language changes", async () => {
    const config = createDefaultConfig("/tmp/gloomberb-language-test");

    testSetup = await testRender(
      <AppProvider config={config}>
        <PaneContent
          component={LanguageProbe}
          paneId="language:test"
          paneType="test"
          focused
          width={24}
          height={4}
        />
      </AppProvider>,
      { width: 32, height: 6 },
    );

    await testSetup.renderOnce();
    expect(testSetup.captureCharFrame()).toContain("Done");

    await act(async () => {
      setLanguage("zh-CN");
      await testSetup!.renderOnce();
    });
    await testSetup.renderOnce();

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("完成");
    expect(frame).not.toContain("Done");
  });
});
