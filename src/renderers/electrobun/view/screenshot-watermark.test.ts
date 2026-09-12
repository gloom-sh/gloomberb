import { expect, test } from "bun:test";
import { screenshotKeySignal } from "./screenshot-watermark";

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
