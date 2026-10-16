/** @jsxImportSource react */
import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { WebInputHostProvider } from "../renderers/dom/input-host";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { renderQrSvgDataUri } from "../ui/qr";
import { SignInCodePanel } from "./sign-in-code-panel";

const harness = createDomTestHarness();
const STATUS = { text: "Waiting...", color: "#888888" };
const CONNECT_URL = "https://gloom.sh/connect/test-ticket";
const LINK_URL = "https://gloom.sh/link/ABCD-1234";

function render(props: Pick<ComponentProps<typeof SignInCodePanel>, "url" | "code" | "height">) {
  return harness.render(
    <WebInputHostProvider>
      <SignInCodePanel {...props} status={STATUS} shortcutScope="test" />
    </WebInputHostProvider>,
  );
}

function qrBox(container: HTMLElement): HTMLElement {
  return container.querySelector("[data-gloom-role=sign-in-qr]") as HTMLElement;
}

test("the QR code is its own square in whole-pixel modules, quiet zone included and nothing around it", async () => {
  const container = await render({ url: CONNECT_URL, code: null, height: 40 });
  const { modules } = renderQrSvgDataUri(CONNECT_URL);
  const box = qrBox(container);
  expect(box.style.width).toBe(`${modules * 4}px`);
  expect(box.style.height).toBe(`${modules * 4}px`);
  expect(box.style.backgroundSize).toBe("100% 100%");
  expect(box.style.padding || "0px").toBe("0px");
  expect(box.style.backgroundColor).toBe("");
  expect(container.querySelector("[data-gloom-role=sign-in-code]")).toBeNull();
});

test("a code is set as text a step above the body, and a short window shrinks the QR code before dropping it", async () => {
  const tall = await render({ url: LINK_URL, code: "ABCD-1234", height: 40 });
  const code = tall.querySelector("[data-gloom-role=sign-in-code]") as HTMLElement;
  expect(code.textContent).toBe("ABCD-1234");
  expect(code.querySelector("[style*=font-size]")?.getAttribute("style")).toContain("font-size: 22px");

  const { modules } = renderQrSvgDataUri(LINK_URL);
  // Room for three-pixel modules only: smaller, still whole pixels.
  const short = await render({ url: LINK_URL, code: "ABCD-1234", height: 8 + Math.ceil((modules * 3) / 18) });
  expect(qrBox(short).style.width).toBe(`${modules * 3}px`);
  const tooShort = await render({ url: LINK_URL, code: "ABCD-1234", height: 12 });
  expect(qrBox(tooShort)).toBeNull();
  expect(tooShort.textContent).toContain("Not enough room to draw the QR code.");
});
