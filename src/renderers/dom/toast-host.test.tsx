/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { useToastHost, type ToastHost } from "../../ui/toast";
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
  const dismiss = container.querySelector("[aria-label='Dismiss notification']") as unknown as HTMLElement;
  await act(async () => {
    dismiss.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(opened).toBe(1);
  expect(container.querySelector(".gloom-toast")).toBeNull();

  toastHost = null;
});

// The Attention Counts notice starts counting from onShown, so it must run
// only once a viewport has drawn the toast, and only once.
test("a DOM toast's onShown runs once, after a viewport first draws it", async () => {
  const shown: string[] = [];
  let showViewport: ((value: boolean) => void) | null = null;
  function MaybeViewport() {
    const [visible, setVisible] = useState(false);
    showViewport = setVisible;
    return visible ? <ToastViewport /> : <HostProbe />;
  }
  function HostProbe() {
    toastHost = useToastHost();
    return null;
  }

  const container = await renderDom(
    <WebToastHostProvider>
      <MaybeViewport />
    </WebToastHostProvider>,
  );
  await act(async () => {
    toastHost?.info("First", { duration: 0, onShown: () => shown.push("first") });
  });
  expect(shown).toEqual([]);

  await act(async () => showViewport?.(true));
  expect(container.querySelector(".gloom-toast")?.textContent).toContain("First");
  expect(shown).toEqual(["first"]);

  await act(async () => {
    toastHost?.info("Second", { duration: 0, onShown: () => shown.push("second") });
  });
  expect(shown).toEqual(["first", "second"]);

  toastHost = null;
});
