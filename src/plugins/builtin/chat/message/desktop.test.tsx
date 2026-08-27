import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { act } from "react";
import { createOpenTuiTestRoot as createRoot } from "../../../../renderers/opentui/test-utils";
import { getThemeColors, syncTheme } from "../../../../theme/colors";
import { ThemeProvider } from "../../../../theme/theme-context";
import { DEFAULT_THEME } from "../../../../theme/themes";
import type { ChatMessage } from "../../../../api-client";
import { DesktopChatMessage } from "./desktop";

let testSetup: Awaited<ReturnType<typeof createTestRenderer>> | undefined;
let root: ReturnType<typeof createRoot> | undefined;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function rgba(hex: string): string {
  const value = hex.slice(1);
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).concat(255).join(",");
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
  }
  testSetup?.renderer.destroy();
  root = undefined;
  testSetup = undefined;
  syncTheme(DEFAULT_THEME);
});

describe("DesktopChatMessage", () => {
  test("updates memoized row colors when the theme changes", async () => {
    const message: ChatMessage = {
      id: "theme-message",
      channelId: "everyone",
      content: "theme message",
      replyToId: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      user: { id: "user-1", username: "vince", displayName: "Vince" },
    };
    const noop = () => {};
    const messageElement = (
      <DesktopChatMessage
        msg={message}
        index={0}
        messages={[message]}
        selectedIdx={0}
        hoveredIdx={null}
        canSend={false}
        catalog={{}}
        userByUsername={new Map()}
        openTicker={noop}
        onUserHover={noop}
        onUserHoverEnd={noop}
        beginReplyTo={noop}
        beginEditMessage={() => false}
        jumpToMessage={noop}
        latestEditableMessageId={null}
        registerMessageElement={noop}
      />
    );

    testSetup = await createTestRenderer({ width: 60, height: 4 });
    root = createRoot(testSetup.renderer);
    act(() => root?.render(<ThemeProvider themeId={DEFAULT_THEME}>{messageElement}</ThemeProvider>));
    await act(async () => {
      await testSetup?.renderOnce();
      await testSetup?.renderOnce();
    });

    const nextThemeId = "github-light";
    act(() => root?.render(<ThemeProvider themeId={nextThemeId}>{messageElement}</ThemeProvider>));
    await act(async () => {
      await testSetup?.renderOnce();
      await testSetup?.renderOnce();
    });

    const bodySpan = testSetup.captureSpans().lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes(message.content));
    const palette = getThemeColors(nextThemeId);
    expect(bodySpan?.fg.toInts().join(",")).toBe(rgba(palette.selectedText));
    expect(bodySpan?.bg.toInts().join(",")).toBe(rgba(palette.selected));
  });
});
