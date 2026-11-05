import { useLayoutEffect, useState } from "react";

const PROMPT_SELECTOR = '[data-gloom-role="header-command-prompt"]';

type MeasuredElement = { getBoundingClientRect(): { width: number } };
type Observer = { observe(element: MeasuredElement): void; disconnect(): void };

/**
 * The open header prompt's width as the desktop and the web laid it out, in
 * cells, or null where nothing measured it (the terminal, whose prompt always
 * gets its geometry's width). The header asks for the geometry's width, but
 * a window too narrow for Help, the market summary and the caption buttons
 * beside the open prompt squeezes it in CSS (header.tsx, nativePromptFit), by
 * pixels only the browser knows. The sheet hangs from the prompt, so it takes
 * the width the prompt was given.
 */
export function useLaidOutPromptWidth(enabled: boolean, cellWidthPx: number): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const doc = (globalThis as { document?: { querySelector?(selector: string): MeasuredElement | null } }).document;
    const prompt = enabled ? doc?.querySelector?.(PROMPT_SELECTOR) : null;
    if (!prompt || cellWidthPx <= 0) {
      setWidth(null);
      return;
    }
    const measure = () => setWidth(prompt.getBoundingClientRect().width / cellWidthPx);
    measure();
    const ResizeObserverCtor = (globalThis as { ResizeObserver?: new (callback: () => void) => Observer }).ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(measure) : null;
    observer?.observe(prompt);
    return () => observer?.disconnect();
  }, [cellWidthPx, enabled]);
  return width;
}
