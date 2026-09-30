import { expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { type TextareaRenderable } from "../../ui";
import { MessageComposer } from "./message-composer";

const tui = createOpenTuiTestHarness();

test("renders a terminal prefix, focuses on click, types, and submits", async () => {
  let focusRequests = 0;
  let submitted = "";

  function Harness() {
    const [focused, setFocused] = useState(false);
    const inputRef = useRef<TextareaRenderable>(null);

    return (
      <MessageComposer
        inputRef={inputRef}
        initialValue=""
        focused={focused}
        placeholder="Say something..."
        width={32}
        height={1}
        terminalPrefix=" > "
        onFocusRequest={() => {
          focusRequests += 1;
          setFocused(true);
        }}
        keyBindings={[{ name: "return", action: "submit" }]}
        onSubmit={() => {
          submitted = inputRef.current?.editBuffer.getText() ?? "";
        }}
      />
    );
  }

  await act(async () => {
    await tui.render(<Harness />, { width: 32, height: 3 });
  });

  await act(async () => {
    await tui.setup().renderOnce();
  });

  expect(tui.frame()).toContain("> Say something...");
  await tui.clickFrameText("Say something...");

  expect(focusRequests).toBe(1);

  await act(async () => {
    await tui.setup().mockInput.typeText("hello");
    await tui.setup().renderOnce();
  });

  expect(tui.frame()).toContain("> hello");

  await act(async () => {
    tui.setup().mockInput.pressEnter();
    await tui.setup().renderOnce();
  });

  expect(submitted).toBe("hello");
});
