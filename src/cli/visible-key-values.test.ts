import { expect, test } from "bun:test";
import { readVisibleKeyValues } from "./visible-key-values";

test("screenshot metrics must fit the viewport and every clipping ancestor", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const style = { display: "flex", visibility: "visible", opacity: "1", overflowX: "visible", overflowY: "visible" };
  const pane = { parentElement: null, style: { ...style, overflowY: "hidden" }, getBoundingClientRect: () => rect(0, 0, 600, 100) };
  const scroll = { parentElement: pane, style: { ...style, overflowX: "auto", overflowY: "auto" }, getBoundingClientRect: () => rect(0, 0, 300, 150) };
  const makeRow = (label: string, bounds: ReturnType<typeof rect>, text = `${label} 1.2345`) => ({
    parentElement: scroll, style, getBoundingClientRect: () => bounds, innerText: text, firstElementChild: { textContent: label },
  });
  const rows = [makeRow("Visible", rect(0, 20, 300, 18)), makeRow("Below ancestor", rect(0, 90, 300, 18)),
    makeRow("Wide", rect(0, 20, 320, 18)), makeRow("Above viewport", rect(0, -10, 300, 18)),
    makeRow("Truncated", rect(0, 20, 300, 18), "Truncated 123…"),
    { ...makeRow("Hidden", rect(0, 20, 300, 18)), style: { ...style, visibility: "hidden" } }];
  const root = { querySelectorAll: () => rows, ownerDocument: { defaultView: {
    innerWidth: 600, innerHeight: 200, getComputedStyle: (element: { style: unknown }) => element.style,
  } } } as unknown as HTMLElement;
  expect(readVisibleKeyValues(root)).toEqual([{ label: "Visible", text: "Visible 1.2345" }]);
  // The browser runner uses the serialized helper, which must not capture imports.
  const evaluated = new Function(`return (${readVisibleKeyValues.toString()})`)() as typeof readVisibleKeyValues;
  expect(evaluated(root)).toEqual(readVisibleKeyValues(root));
});
