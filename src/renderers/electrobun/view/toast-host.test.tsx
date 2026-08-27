/** @jsxImportSource react */
import { Window } from "happy-dom";

const testWindow = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  MouseEvent: testWindow.MouseEvent,
});

import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useToastHost, type ToastHost } from "../../../ui/toast";
import { WebToastHostProvider } from "./toast-host";

let toastHost: ToastHost | null = null;

function ToastViewport() {
  const host = useToastHost();
  toastHost = host;
  const Viewport = host.Viewport;
  return <Viewport />;
}

test("DOM notifications show context and open from the whole card", async () => {
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  let opened = 0;

  await act(async () => {
    root.render(
      <WebToastHostProvider>
        <ToastViewport />
      </WebToastHostProvider>,
    );
  });
  await act(async () => {
    toastHost?.info("@bob mentioned you", {
      title: "Gloomberb chat",
      subtitle: "#everyone",
      duration: 0,
      action: { label: "Open", onClick: () => opened++ },
    });
  });

  const toast = container.querySelector(".gloom-toast") as unknown as HTMLElement;
  expect(toast.textContent).toContain("Gloomberb chat");
  expect(toast.textContent).toContain("#everyone");
  expect(toast.getAttribute("data-actionable")).toBe("true");

  await act(async () => {
    toast.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(opened).toBe(1);
  expect(container.querySelector(".gloom-toast")).toBeNull();

  await act(async () => {
    toastHost?.info("Another message", {
      duration: 0,
      action: { label: "Open", onClick: () => opened++ },
    });
  });
  const dismiss = container.querySelector(".gloom-toast-dismiss") as unknown as HTMLElement;
  await act(async () => {
    dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(opened).toBe(1);
  expect(container.querySelector(".gloom-toast")).toBeNull();

  await act(async () => root.unmount());
  container.remove();
  toastHost = null;
});
