import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../../ui";
import { testRender } from "../../../../renderers/opentui/test-utils";
import {
  PaneFooterBar,
  PaneFooterProvider,
  usePaneFooter,
} from "./index";
import { useExternalLinkFooter } from "../../../use-external-link-footer";
import { setLanguage, t } from "../../../../i18n";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup?.renderer.destroy());
    testSetup = undefined;
  }
  setLanguage("en");
});

function Registration({
  onRefresh,
  refreshDisabled = false,
}: {
  onRefresh?: () => void;
  refreshDisabled?: boolean;
}) {
  usePaneFooter("test", () => {
    return {
      info: [
        {
          id: "rows",
          parts: [
            { text: "Rows", tone: "label" },
            { text: "12", tone: "value", bold: true },
          ],
        },
      ],
      hints: [
        { id: "refresh", key: "r", label: "efresh", onPress: onRefresh, disabled: refreshDisabled },
      ],
    };
  }, [onRefresh, refreshDisabled]);
  return null;
}

function ExternalLinkRegistration() {
  useExternalLinkFooter({
    registrationId: "external-link",
    focused: true,
    url: "https://example.com/story?utm=raw",
    source: "Reuters",
  });
  return null;
}

function TranslatedRegistration() {
  usePaneFooter("translated", () => ({
    info: [{ id: "state", parts: [{ text: t("Open"), tone: "value" }] }],
  }), []);
  return null;
}

function TranslatedFooterHarness() {
  return (
    <PaneFooterProvider>
      {(footer) => (
        <Box width={40} height={1}>
          <TranslatedRegistration />
          <PaneFooterBar footer={footer} focused width={40} />
        </Box>
      )}
    </PaneFooterProvider>
  );
}

function FooterHarness({
  focused = false,
  onRefresh,
  refreshDisabled = false,
}: {
  focused?: boolean;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
}) {
  return (
    <PaneFooterProvider>
      {(footer) => (
        <Box width={64} height={1}>
          <Registration onRefresh={onRefresh} refreshDisabled={refreshDisabled} />
          <PaneFooterBar footer={footer} focused={focused} width={64} />
        </Box>
      )}
    </PaneFooterProvider>
  );
}

function ExternalLinkFooterHarness() {
  return (
    <PaneFooterProvider>
      {(footer) => (
        <Box width={80} height={1}>
          <ExternalLinkRegistration />
          <PaneFooterBar footer={footer} focused width={80} />
        </Box>
      )}
    </PaneFooterProvider>
  );
}

describe("PaneFooterBar", () => {
  test("rebuilds translated registrations when the app language changes", async () => {
    testSetup = await testRender(<TranslatedFooterHarness />, { width: 40, height: 1 });
    await act(async () => {
      await testSetup?.renderOnce();
      await testSetup?.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("Open");

    await act(async () => {
      setLanguage("zh-CN");
      await Promise.resolve();
    });
    await act(async () => {
      await testSetup?.renderOnce();
      await testSetup?.renderOnce();
      await Promise.resolve();
      await testSetup?.renderOnce();
    });
    expect(testSetup.captureCharFrame()).toContain("打开");
  });

  test("hides hints on inactive footers but keeps info visible", async () => {
    testSetup = await testRender(<FooterHarness />, { width: 64, height: 1 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Rows 12");
    expect(frame).not.toContain("[r]efresh");
  });

  test("keeps raw external URLs out of footer text", async () => {
    testSetup = await testRender(<ExternalLinkFooterHarness />, { width: 80, height: 1 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("source Reuters");
    expect(frame).toContain("[o]pen");
    expect(frame).not.toContain("https://example.com");
  });

  test("omits disabled controls instead of rendering muted hints", async () => {
    testSetup = await testRender(
      <FooterHarness focused refreshDisabled onRefresh={() => {}} />,
      { width: 64, height: 1 },
    );
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const frame = testSetup.captureCharFrame();
    expect(frame).toContain("Rows 12");
    expect(frame).not.toContain("[r]efresh");
  });

  test("calls hint onPress from mouse interaction", async () => {
    let refreshCount = 0;
    testSetup = await testRender(<FooterHarness focused onRefresh={() => { refreshCount += 1; }} />, { width: 64, height: 1 });
    await act(async () => {
      await testSetup!.renderOnce();
      await testSetup!.renderOnce();
    });

    const line = testSetup.captureCharFrame().split("\n")[0] ?? "";
    const col = line.indexOf("[r]efresh");
    expect(col).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await testSetup!.mockMouse.release(col + 1, 0);
      await testSetup!.renderOnce();
    });
    expect(refreshCount).toBe(0);

    await act(async () => {
      await testSetup!.mockMouse.click(col + 1, 0);
      await testSetup!.renderOnce();
    });
    expect(refreshCount).toBe(1);
  });
});
