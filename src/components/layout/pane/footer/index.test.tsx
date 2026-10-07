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

  test("hints that do not fit open from More and run from there", async () => {
    const actions: string[] = [];
    function Crowded() {
      usePaneFooter("crowded", () => ({
        info: [{ id: "loading", parts: [{ text: "loading", tone: "muted" }] }],
        hints: [
          { id: "search", key: "/", label: "search", onPress: () => actions.push("search") },
          { id: "open", key: "o", label: "pen", onPress: () => actions.push("open") },
          { id: "pop-out", key: "p", label: "op out", onPress: () => actions.push("pop-out") },
          { id: "share", key: "s", label: "hare", onPress: () => actions.push("share") },
          { id: "archive", key: "a", label: "rchive", onPress: () => actions.push("archive") },
          { id: "bookmark", key: "b", label: "ookmark", onPress: () => actions.push("bookmark") },
          { id: "copy", key: "c", label: "opy", onPress: () => actions.push("copy") },
          { id: "yank", key: "y", label: "ank", onPress: () => actions.push("yank") },
        ],
      }), []);
      return null;
    }
    await tui.render(
      <PaneFooterProvider>
        {(footer) => (
          <Box width={34} height={18} flexDirection="column">
            <Crowded />
            <PaneFooterBar footer={footer} focused width={34} />
          </Box>
        )}
      </PaneFooterProvider>,
      { width: 34, height: 18 },
    );
    await act(async () => {
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    const frame = tui.frame();
    expect(frame).toContain("loading");
    expect(frame).toContain("[/]search");
    expect(frame).toContain("More");
    expect(frame).not.toContain("[y]ank");

    const lines = frame.split("\n");
    const moreRow = lines.findIndex((line) => line.includes("More"));
    expect(moreRow).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await tui.setup().mockMouse.click(lines[moreRow]!.indexOf("More"), moreRow);
      await tui.setup().renderOnce();
      await tui.setup().renderOnce();
    });
    const menuLines = tui.frame().split("\n");
    const yankRow = menuLines.findIndex((line) => line.includes("[y]ank"));
    expect(yankRow).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await tui.setup().mockMouse.click(menuLines[yankRow]!.indexOf("[y]ank"), yankRow);
      await tui.setup().renderOnce();
    });
    expect(actions).toEqual(["yank"]);
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
