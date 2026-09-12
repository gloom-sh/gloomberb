import { expect, test } from "bun:test";
import { createDomTestHarness } from "./test-utils";
import { installScreenshotWatermark, screenshotKeySignal } from "./screenshot-watermark";
import { SCREENSHOT_WATERMARK_ATTRIBUTE } from "../../../utils/screenshot-watermark";

const { window: testWindow } = createDomTestHarness({ withUi: false });

test("the modifier prefix of an OS screenshot chord reveals the watermark", () => {
  // Cmd+Shift+4: the page sees Meta, then Shift, and never the digit.
  expect(screenshotKeySignal({ key: "Meta", metaKey: true, shiftKey: false })).toBe("keep");
  expect(screenshotKeySignal({ key: "Shift", metaKey: true, shiftKey: true })).toBe("show");
  // Win+Shift+S arrives in the other order.
  expect(screenshotKeySignal({ key: "Meta", metaKey: true, shiftKey: true })).toBe("show");
  expect(screenshotKeySignal({ key: "PrintScreen", metaKey: false, shiftKey: false })).toBe("show");
});

test("a complete chord that reaches the page is an app shortcut, not a screenshot", () => {
  expect(screenshotKeySignal({ key: "c", metaKey: true, shiftKey: true })).toBe("hide");
  expect(screenshotKeySignal({ key: "Escape", metaKey: false, shiftKey: false })).toBe("hide");
  expect(screenshotKeySignal({ key: "Shift", metaKey: false, shiftKey: true })).toBe("keep");
  expect(screenshotKeySignal({ key: "Control", metaKey: false, shiftKey: true })).toBe("keep");
});

test("a capture app taking focus holds the watermark until focus returns", async () => {
  const win = testWindow as unknown as Window;
  const shown = () => win.document.documentElement.getAttribute(SCREENSHOT_WATERMARK_ATTRIBUTE) === "true";
  const dispatch = (event: unknown) => win.dispatchEvent(event as Event);
  const uninstall = installScreenshotWatermark(win);
  try {
    dispatch(new testWindow.KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    expect(shown()).toBe(false);
    dispatch(new testWindow.KeyboardEvent("keydown", { key: "Shift", metaKey: true, shiftKey: true }));
    expect(shown()).toBe(true);

    // Cmd+Shift+5: the Screenshot app owns focus for as long as it likes.
    dispatch(new testWindow.Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shown()).toBe(true);
    dispatch(new testWindow.Event("focus"));
    expect(shown()).toBe(true);

    // Back in the app, any real interaction clears it at once.
    dispatch(new testWindow.MouseEvent("mousedown"));
    expect(shown()).toBe(false);
  } finally {
    uninstall();
  }
});
