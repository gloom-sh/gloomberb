/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { useToastHost, type ToastHost } from "../../../ui/toast";
import { WebToastHostProvider } from "./toast-host";
import { createDomTestHarness } from "./test-utils";

const { render: renderDom } = createDomTestHarness({ withUi: false });

let toastHost: ToastHost | null = null;

function ToastViewport() {
  const host = useToastHost();
  toastHost = host;
  const Viewport = host.Viewport;
  return <Viewport />;
}

test("DOM notifications show context and open from the whole card", async () => {
  let opened = 0;

  const container = await renderDom(
    <WebToastHostProvider>
      <ToastViewport />
    </WebToastHostProvider>,
  );
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

  toastHost = null;
});
