import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { Box } from "../../../../ui";
import { createOpenTuiTestHarness } from "../../../../renderers/opentui/test-utils";
import {
  PaneFooterBar,
  PaneFooterProvider,
  usePaneFooter,
} from "./index";
import { useExternalLinkFooter } from "../../../use-external-link-footer";
import { setLanguage, t } from "../../../../i18n";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setLanguage("en");
});

function Registration({
  onOpen,
  openDisabled = false,
}: {
  onOpen?: () => void;
  openDisabled?: boolean;
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
        { id: "open", key: "o", label: "pen", onPress: onOpen, disabled: openDisabled },
      ],
    };
  }, [onOpen, openDisabled]);
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
  onOpen,
  openDisabled = false,
}: {
  focused?: boolean;
  onOpen?: () => void;
  openDisabled?: boolean;
}) {
  return (
    <PaneFooterProvider>
      {(footer) => (
        <Box width={64} height={1}>
          <Registration onOpen={onOpen} openDisabled={openDisabled} />
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
    await tui.render(<TranslatedFooterHarness />, { width: 40, height: 1 });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("Open");

    await act(async () => {
      setLanguage("zh-CN");
      await Promise.resolve();
    });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
      await Promise.resolve();
      await tui.setup().renderOnce();
    });
    expect(tui.frame()).toContain("打开");
  });

  test("hides hints on inactive footers but keeps info visible", async () => {
    await tui.render(<FooterHarness />, { width: 64, height: 1 });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("Rows 12");
    expect(frame).not.toContain("[o]pen");
  });

  test("keeps raw external URLs out of footer text", async () => {
    await tui.render(<ExternalLinkFooterHarness />, { width: 80, height: 1 });
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("source Reuters");
    expect(frame).toContain("[o]pen");
    expect(frame).not.toContain("https://example.com");
  });

  test("omits disabled controls instead of rendering muted hints", async () => {
    await tui.render(
      <FooterHarness focused openDisabled onOpen={() => {}} />,
      { width: 64, height: 1 },
    );
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });

    const frame = tui.frame();
    expect(frame).toContain("Rows 12");
    expect(frame).not.toContain("[o]pen");
  });
});
