import type { NativeFrameCapture } from "../../ui/host";

interface FrameSource {
  isDestroyed?: boolean;
  currentRenderBuffer: {
    width: number;
    height: number;
    getSpanLines(): Array<{
      spans: Array<{
        text: string;
        fg: { toInts(): [number, number, number, number] };
        bg: { toInts(): [number, number, number, number] };
        attributes: number;
      }>;
    }>;
  };
}

/** The last frame the renderer drew, as styled rows: one code point per cell. */
export function captureRendererFrame(renderer: FrameSource): NativeFrameCapture | null {
  if (renderer.isDestroyed) return null;
  const buffer = renderer.currentRenderBuffer;
  return {
    cols: buffer.width,
    rows: buffer.height,
    lines: buffer.getSpanLines().map((line) => line.spans.map((span) => ({
      text: span.text,
      fg: span.fg.toInts(),
      bg: span.bg.toInts(),
      attributes: span.attributes,
    }))),
  };
}
