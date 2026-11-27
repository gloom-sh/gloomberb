/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../test-utils";
import { WebInput, WebTextarea } from "./input";

const { window: testWindow, render } = createDomTestHarness();

async function mountField({ initial = "", multiline = false, listPaste = false } = {}) {
  const changes: string[] = [];
  const submits: string[] = [];
  const blurs: string[] = [];
  let setOwnerValue: (value: string) => void = () => { throw new Error("No field owner"); };
  const Field = multiline ? WebTextarea : WebInput;
  function Owner() {
    const [value, setValue] = useState(initial);
    setOwnerValue = setValue;
    return <>
      <Field
        value={value}
        joinPastedLines={listPaste ? "list" : undefined}
        onInput={(next: string) => { changes.push(next); setValue(next); }}
        onSubmit={(next: string) => submits.push(next)}
        onBlur={(next: string) => blurs.push(next)}
      />
      <button type="button">Other control</button>
    </>;
  }
  const root = await render(<Owner />);
  const field = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(multiline ? "textarea" : "input")!;
  await act(async () => field.focus());
  const composition = (type: "compositionstart" | "compositionend", data = "") => {
    field.dispatchEvent(new testWindow.CompositionEvent(type, { bubbles: true, data }) as unknown as Event);
  };
  const input = (value: string, inputType = "insertText", isComposing = false) => {
    field.value = value;
    field.dispatchEvent(new testWindow.InputEvent("input", { bubbles: true, inputType, isComposing }) as unknown as Event);
  };
  const enter = (options: { isComposing?: boolean; keyCode?: number } = {}) => {
    const event = new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
    field.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  return { field, changes, submits, blurs, composition, input, enter, setOwnerValue, other: root.querySelector("button")! };
}

function nextFrame(): Promise<void> {
  return act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

test.each(["Chromium", "WebKit"])("reports one committed composition and leaves the confirming key to the IME (%s ordering)", async (engine) => {
  const { field, changes, submits, composition, input, enter } = await mountField({ multiline: engine === "Chromium" });
  await act(async () => {
    composition("compositionstart");
    input("ni", "insertCompositionText", true);
  });
  field.value = "nihao";
  await nextFrame();
  expect(field.value).toBe("nihao");
  expect(changes).toEqual([]);

  await act(async () => {
    if (engine === "Chromium") {
      expect(enter({ isComposing: true, keyCode: 13 })).toBe(false);
      input("你好", "insertCompositionText", true);
    }
    field.value = "你好";
    composition("compositionend", "你好");
    if (engine === "WebKit") {
      expect(enter({ isComposing: false, keyCode: 229 })).toBe(false);
      input("你好", "insertFromComposition");
    }
  });
  await nextFrame();
  expect(changes).toEqual(["你好"]);
  expect(submits).toEqual([]);
  await act(async () => { expect(enter()).toBe(true); });
  expect(submits).toEqual(["你好"]);
});

test("a cancelled composition does not report a change to the prior text", async () => {
  const { field, changes, composition, input } = await mountField({ initial: "AAPL" });
  await act(async () => { composition("compositionstart"); input("AAPLni", "insertCompositionText", true); });
  await act(async () => {
    input("AAPL", "deleteCompositionText", true);
    composition("compositionend");
  });
  await nextFrame();
  expect(field.value).toBe("AAPL");
  expect(changes).toEqual([]);
});

test("blur without compositionend discards the draft and resumes frame sync on refocus", async () => {
  const { field, other, changes, blurs, composition, input } = await mountField({ initial: "AAPL" });
  await act(async () => { composition("compositionstart"); input("AAPLni", "insertCompositionText", true); });
  await act(async () => other.focus());
  expect(field.value).toBe("AAPL");
  expect(blurs).toEqual(["AAPL"]);
  expect(changes).toEqual([]);

  await act(async () => field.focus());
  field.value = "AAPL MSFT";
  await nextFrame();
  expect(changes).toEqual(["AAPL MSFT"]);
});

test("an owner value change or a subsequent ordinary input recovers a missing compositionend", async () => {
  const { field, changes, composition, input, setOwnerValue } = await mountField();
  await act(async () => { composition("compositionstart"); input("ni", "insertCompositionText", true); });
  await act(async () => setOwnerValue("AAPL"));
  expect(field.value).toBe("AAPL");
  await act(async () => composition("compositionend", "ni"));
  expect(changes).toEqual([]);

  await act(async () => { composition("compositionstart"); input("AAPLni", "insertCompositionText", true); });
  await act(async () => input("AAPLx"));
  await nextFrame();
  expect(changes).toEqual(["AAPLx"]);
});

test("plain typing and paste still report edits, including a pasted list", async () => {
  const { field, changes, input } = await mountField({ listPaste: true });
  const paste = (text: string) => {
    const clipboardData = new testWindow.DataTransfer();
    clipboardData.setData("text/plain", text);
    const event = new testWindow.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    field.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  await act(async () => input("AAPL"));
  await act(async () => {
    expect(paste(" MSFT")).toBe(false);
    input("AAPL MSFT", "insertFromPaste");
  });
  await act(async () => {
    field.select();
    expect(paste("Apple Inc\tVOD LN\nBARC LN")).toBe(true);
  });
  expect(changes).toEqual(["AAPL", "AAPL MSFT", "Apple Inc, VOD LN, BARC LN"]);
});
