import { useMemo, type ReactNode } from "react";
import { testRender as openTuiTestRender } from "@opentui/react/test-utils";
import { createRoot as openTuiCreateRoot, useRenderer } from "@opentui/react";
import { UiHostProvider, type NativeRendererHost, type RendererHost } from "../../ui";
import { ToastHostProvider } from "../../ui/toast";
import { colors } from "../../theme/colors";
import { OpenTuiInputHostProvider } from "./input-host";
import { openTuiUiHost } from "./ui-host";
import { OpenTuiDialogHostProvider } from "./dialog-host";
import { openTuiToastHost } from "./toast-host";

export function TestDialogProvider({ children }: { children: ReactNode }) {
  return (
    <OpenTuiDialogHostProvider
      dialogOptions={{
        style: {
          backgroundColor: colors.bg,
          borderColor: colors.borderFocused,
          borderStyle: "single",
        },
      }}
    >
      {children}
    </OpenTuiDialogHostProvider>
  );
}

function createTestNativeRendererHost(renderer: any): NativeRendererHost {
  if (typeof renderer.write !== "function") {
    renderer.write = (data: string | Uint8Array) => {
      if (renderer.isDestroyed) return false;
      const writer = renderer.writeOut;
      if (typeof writer !== "function") return false;
      writer.call(renderer, data);
      return true;
    };
  }
  return renderer as NativeRendererHost;
}

function OpenTuiTestProviders({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const rendererHost = useMemo<RendererHost>(() => ({
    requestExit: () => renderer.destroy?.(),
    openExternal: async () => {},
    copyText: async () => {},
    readText: async () => "",
    notify: () => {},
  }), [renderer]);
  const nativeRenderer = useMemo(() => createTestNativeRendererHost(renderer), [renderer]);

  return (
    <UiHostProvider ui={openTuiUiHost} renderer={rendererHost} nativeRenderer={nativeRenderer}>
      <OpenTuiInputHostProvider>
        <ToastHostProvider host={openTuiToastHost}>
          <OpenTuiDialogHostProvider
            dialogOptions={{
              style: {
                backgroundColor: colors.bg,
                borderColor: colors.borderFocused,
                borderStyle: "single",
              },
            }}
          >
            {children}
          </OpenTuiDialogHostProvider>
        </ToastHostProvider>
      </OpenTuiInputHostProvider>
    </UiHostProvider>
  );
}

function withOpenTuiTestProviders(node: ReactNode): ReactNode {
  return <OpenTuiTestProviders>{node}</OpenTuiTestProviders>;
}

export function testRender(
  node: ReactNode,
  options?: Parameters<typeof openTuiTestRender>[1],
): ReturnType<typeof openTuiTestRender> {
  return openTuiTestRender(withOpenTuiTestProviders(node), options);
}

export function createOpenTuiTestRoot(
  renderer: Parameters<typeof openTuiCreateRoot>[0],
): ReturnType<typeof openTuiCreateRoot> {
  const root = openTuiCreateRoot(renderer);
  return new Proxy(root, {
    get(target, property, receiver) {
      if (property === "render") {
        return (node: ReactNode) => target.render(withOpenTuiTestProviders(node));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
