import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { resetTerminalInputState } from "../../utils/terminal-input-reset";
import type { KeyEventLike } from "../../react/input";
import type { NativeRendererHost, PixelResolution, RendererHost } from "../../ui/host";
import { colors } from "../../theme/colors";

export { useKeyboard, useTerminalDimensions };

export interface OpenTuiHost {
  renderer: CliRenderer;
  rendererHost: RendererHost;
  nativeRenderer: NativeRendererHost;
  render(node: ReactNode): void;
  destroy(): void;
}

export function toKeyEventLike(event: {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  option?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  defaultPrevented?: boolean;
  propagationStopped?: boolean;
  sequence?: string;
  key?: string;
  super?: boolean;
}): KeyEventLike {
  const key = event.name ?? event.key ?? "";
  return {
    key,
    name: key,
    sequence: event.sequence,
    ctrl: event.ctrl ?? false,
    shift: event.shift ?? false,
    // OpenTUI follows terminal naming: `meta` is Alt/Option, while the
    // kitty keyboard protocol exposes the Command/Windows modifier as
    // `super`. Keep the shared input model aligned with browser semantics.
    alt: event.alt === true || event.meta === true || event.option === true,
    meta: event.super === true,
    super: event.super === true,
    get defaultPrevented() {
      return event.defaultPrevented ?? false;
    },
    get propagationStopped() {
      return event.propagationStopped ?? false;
    },
    preventDefault: () => event.preventDefault?.(),
    stopPropagation: () => event.stopPropagation?.(),
  };
}

function samePixelResolution(left: PixelResolution | null, right: PixelResolution | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.width === right.width && left.height === right.height;
}

function installResolutionEventBridge(renderer: CliRenderer): void {
  let lastResolution = renderer.resolution ?? null;
  const emitIfChanged = () => {
    const nextResolution = renderer.resolution ?? null;
    if (samePixelResolution(lastResolution, nextResolution)) return;
    lastResolution = nextResolution;
    renderer.emit("resolution", nextResolution);
  };

  renderer.prependInputHandler(() => {
    queueMicrotask(emitIfChanged);
    return false;
  });
  renderer.on("resize", () => {
    queueMicrotask(emitIfChanged);
  });
}

export async function createOpenTuiHost(): Promise<OpenTuiHost> {
  resetTerminalInputState();

  // Mouse motion is reported per pixel; our @opentui/core patch coalesces moves
  // to one per fastest frame (~16ms) so pointer-tracked UI like the chart
  // crosshair follows the cursor instead of stepping at 10fps.
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: colors.bg,
    enableMouseMovement: true,
  });
  const root = createRoot(renderer);
  installResolutionEventBridge(renderer);

  const rendererHost: RendererHost = {
    requestExit: () => renderer.destroy(),
    async openExternal(url) {
      const command = process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
      const proc = Bun.spawn(command, {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    },
    async copyText(text) {
      if (!text) return;
      if (renderer.copyToClipboardOSC52(text)) return;
      if (process.platform !== "darwin") return;
      const proc = Bun.spawn(["pbcopy"], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
    },
    async readText() {
      if (process.platform !== "darwin") return "";
      const proc = Bun.spawn(["pbpaste"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      return await new Response(proc.stdout).text();
    },
    notify() {
      // The app-level notifier still owns toast/desktop notification behavior.
    },
    async playTerminalMedia(url, title, options) {
      const mpv = Bun.which("mpv");
      if (!mpv) {
        throw new Error("mpv is required for terminal TV playback. Install mpv and try again.");
      }

      renderer.suspend();
      try {
        const proc = Bun.spawn([
          mpv,
          "--no-config",
          "--profile=sw-fast",
          "--vo=kitty",
          "--vo-kitty-auto-multiplexer-passthrough=yes",
          "--demuxer-lavf-probe-info=yes",
          "--demuxer-lavf-analyzeduration=10",
          "--demuxer-lavf-probesize=25000000",
          "--ytdl=no",
          `--mute=${options?.muted === false ? "no" : "yes"}`,
          ...(title ? [`--title=${title}`] : []),
          "--",
          url,
        ], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "pipe",
        });
        const stderrPromise = new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        const stderr = await stderrPromise;
        if (exitCode !== 0) {
          const detail = stderr.trim().split("\n").slice(-3).join(" ");
          throw new Error(detail || `mpv exited with status ${exitCode}`);
        }
      } finally {
        renderer.resume();
        renderer.requestRender();
      }
    },
  };

  const nativeRenderer: NativeRendererHost = {
    get terminalWidth() {
      return renderer.terminalWidth;
    },
    get terminalHeight() {
      return renderer.terminalHeight;
    },
    get resolution() {
      return renderer.resolution ?? null;
    },
    get capabilities() {
      return renderer.capabilities;
    },
    get isDestroyed() {
      return renderer.isDestroyed;
    },
    get currentFocusedRenderable() {
      return renderer.currentFocusedRenderable ?? null;
    },
    get currentFocusedEditor() {
      return renderer.currentFocusedEditor ?? null;
    },
    get keyInput() {
      return renderer.keyInput as unknown as NativeRendererHost["keyInput"];
    },
    on: (event, handler) => renderer.on(event, handler),
    off: (event, handler) => renderer.off(event, handler),
    requestRender: () => renderer.requestRender(),
    registerLifecyclePass: (renderable) => renderer.registerLifecyclePass(renderable as any),
    unregisterLifecyclePass: (renderable) => renderer.unregisterLifecyclePass(renderable as any),
    getSelection: () => renderer.getSelection(),
    getCursorState: () => renderer.getCursorState(),
    setCursorPosition: (x, y, visible = true) => renderer.setCursorPosition(x, y, visible),
    addPostProcessFn: (processFn) => renderer.addPostProcessFn(processFn as any),
    removePostProcessFn: (processFn) => renderer.removePostProcessFn(processFn as any),
    copyToClipboardOSC52: (text) => renderer.copyToClipboardOSC52(text),
    captureMouseRenderable(renderable) {
      const capture = (renderer as unknown as { setCapturedRenderable?: (target: unknown) => void }).setCapturedRenderable;
      if (typeof capture === "function") {
        capture.call(renderer, renderable);
      }
    },
    write(data) {
      if (renderer.isDestroyed) return false;
      const writer = (renderer as unknown as { writeOut?: (payload: string | Uint8Array) => void }).writeOut;
      if (typeof writer !== "function") return false;
      writer.call(renderer, data);
      return true;
    },
  };

  return {
    renderer,
    rendererHost,
    nativeRenderer,
    render: (node) => root.render(node),
    destroy: () => renderer.destroy(),
  };
}
