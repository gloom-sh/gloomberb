import { describe, expect, test } from "bun:test";
import { createDomTestHarness } from "../test-utils";
import { installFocusScopeRelease, isEditableTarget, shouldReleaseFocus } from "./focus-scope";

const { window } = createDomTestHarness({ withUi: false });

function field(scope?: { contains: (node: unknown) => boolean }) {
  return {
    tagName: "INPUT",
    closest: () => scope ?? null,
    contains: (node: unknown) => node === undefined,
  };
}

describe("focus scope release", () => {
  test("releases focus for a press outside the widget that owns it", () => {
    expect(shouldReleaseFocus(field(), { tagName: "DIV" })).toBe(true);
  });

  test("keeps focus for a press on the owning widget's own chrome", () => {
    const suggestion = { tagName: "DIV" };
    expect(shouldReleaseFocus(field({ contains: (n) => n === suggestion }), suggestion)).toBe(false);
  });

  test("ignores presses while nothing editable holds focus", () => {
    expect(shouldReleaseFocus({ tagName: "DIV", closest: () => null }, {})).toBe(false);
    expect(shouldReleaseFocus(null, {})).toBe(false);
  });

  test("leaves a press inside a dialog alone, which owns the pointer itself", () => {
    const inDialog = { tagName: "INPUT", closest: (selector: string) => selector === ".gloom-dialog" ? {} : null };
    expect(shouldReleaseFocus(field(), inDialog)).toBe(false);
  });

  test("recognises the field a press is about to focus", () => {
    expect(isEditableTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "canvas" })).toBe(false);
  });
});

describe("pointer focus release", () => {
  function mountApp() {
    const doc = window.document;
    const root = doc.createElement("div");
    root.tabIndex = -1;
    root.innerHTML = `<p>The quick brown fox</p><button>Reply</button>`;
    doc.body.appendChild(root);
    root.focus();
    return { doc, root, text: root.querySelector("p")!, button: root.querySelector("button")! };
  }

  async function click(target: { dispatchEvent: (event: never) => boolean }) {
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }) as never);
    await Promise.resolve();
  }

  // WebKit clears the document selection whenever the focus moves, so blurring
  // the app root after a drag dropped the text the user had just selected.
  test("keeps the focus behind text a drag just selected", async () => {
    const uninstall = installFocusScopeRelease();
    try {
      const { doc, root, text } = mountApp();
      doc.getSelection()!.setBaseAndExtent(text.firstChild!, 4, text.firstChild!, 9);
      await click(text);
      expect(doc.activeElement).toBe(root);
    } finally {
      uninstall();
    }
  });

  test("still releases a pressed button while text elsewhere stays selected", async () => {
    const uninstall = installFocusScopeRelease();
    try {
      const { doc, text, button } = mountApp();
      doc.getSelection()!.selectAllChildren(text);
      button.focus();
      await click(button);
      expect(doc.activeElement).toBe(doc.body);
    } finally {
      uninstall();
    }
  });
});
